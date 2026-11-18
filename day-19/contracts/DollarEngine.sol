// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {EverestDollar} from "./EverestDollar.sol";

/// @notice The Chainlink AggregatorV3 functions the engine needs, plus the feed's circuit-breaker band.
interface IPriceFeed {
    function decimals() external view returns (uint8);
    function minAnswer() external view returns (int256);
    function maxAnswer() external view returns (int256);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title DollarEngine — lock ETH, mint Everest Dollars (EUSD)
/// @author Manish Khadka
/// @notice A mini stablecoin system, like a tiny MakerDAO:
///         1. Lock ETH in your vault.
///         2. Mint EUSD against it, as long as the ETH is worth at least 150% of your debt.
///         3. Burn EUSD to repay, then take your ETH back.
///         If ETH falls and a vault drops below 150%, anyone can liquidate it: burn up to half of its
///         EUSD debt and take that value in ETH plus a 10% bonus (below 110%: close the whole vault). This keeps every EUSD backed by
///         more than $1 of ETH, which is what keeps the coin at $1 (the "peg").
/// @dev    No owner and no admin keys. Price safety (the day's security focus):
///         - the price must be fresh (at most 1 hour old), from a finished round, not from the future;
///         - the price must be strictly inside the feed's [minAnswer, maxAnswer] band, because a feed
///           stuck on its floor reports a price that is too HIGH during a crash (the LUNA lesson);
///         - actions that only make the system safer (deposit, repay, withdraw with no debt) work even
///           when the price is broken; actions that need a price (mint, withdraw with debt, liquidate)
///           are refused.
///         Rounding always favours the system: collateral value rounds down, seized ETH rounds down.
contract DollarEngine is ReentrancyGuard {
    // ---------------------------------------------------------------- settings
    uint256 public constant WAD = 1e18;
    uint256 public constant MIN_RATIO = 1.5e18; // ETH must be worth ≥ 150% of the debt
    uint256 public constant LIQ_BONUS = 0.1e18; // liquidators get 10% extra ETH
    uint256 public constant CLOSE_FACTOR = 0.5e18; // at most half a debt per liquidation...
    // ...unless the ETH cannot even cover the debt plus the bonus: then the whole debt can be closed.
    uint256 public constant MIN_DEBT = 100e18; // no dust vaults too small to be worth liquidating
    uint256 public constant MAX_PRICE_AGE = 1 hours;

    // Lower-case names for immutables so the public getters read like Chainlink / ERC-20 APIs.
    // solhint-disable immutable-vars-naming
    EverestDollar public immutable eusd;
    IPriceFeed public immutable feed;
    /// @notice The most EUSD that can ever be outstanding. Limits the damage of any unknown bug.
    uint256 public immutable debtCeiling;
    int256 private immutable _feedMin;
    int256 private immutable _feedMax;
    uint256 private immutable _scale; // turns the feed's decimals into 18
    // solhint-enable immutable-vars-naming

    struct Vault {
        uint256 collateral; // ETH locked, in wei
        uint256 debt; // EUSD owed, 18 decimals
    }

    mapping(address => Vault) public vaults;
    /// @notice ETH locked in all vaults together. Counted, not read from address(this).balance,
    ///         so ETH force-sent to the engine cannot make the coin look better backed than it is.
    uint256 public totalCollateral;
    /// @notice EUSD debt of all vaults together.
    uint256 public totalDebt;
    /// @notice EUSD still in circulation whose vault ran out of ETH. Kept in the open, never hidden.
    uint256 public badDebt;

    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event Minted(address indexed user, uint256 amount);
    event Repaid(address indexed user, uint256 amount);
    event Liquidated(address indexed user, address indexed liquidator, uint256 repaid, uint256 seized, uint256 badDebt);

    error ZeroAmount();
    error BadFeed();
    error Unhealthy(uint256 ratio);
    error StillHealthy(uint256 ratio);
    error DustDebt(uint256 debt);
    error CeilingReached(uint256 totalDebt, uint256 ceiling);
    error RepayTooLarge(uint256 amount, uint256 max);
    error RepayTooSmall(uint256 amount, uint256 needed);
    error NotEnough(uint256 amount, uint256 available);
    error EthTransferFailed();
    error PriceOutOfBounds(int256 answer);
    error StalePrice(uint256 updatedAt, uint256 nowTime);
    error IncompleteRound(uint80 roundId, uint80 answeredInRound);
    error UseDeposit();

    constructor(IPriceFeed feed_, uint256 debtCeiling_) {
        uint8 dec = feed_.decimals();
        int256 lo = feed_.minAnswer();
        int256 hi = feed_.maxAnswer();
        if (dec > 18 || lo < 0 || hi <= lo || debtCeiling_ == 0) revert BadFeed();
        feed = feed_;
        debtCeiling = debtCeiling_;
        _feedMin = lo;
        _feedMax = hi;
        _scale = 10 ** (18 - dec);
        eusd = new EverestDollar(); // this engine becomes the token's only minter, forever
    }

    /// @dev Plain ETH sent by mistake would be locked without a vault; make people use deposit().
    receive() external payable {
        revert UseDeposit();
    }

    // ---------------------------------------------------------------- vault owner actions

    /// @notice Lock ETH in your vault. Works even when the price feed is broken.
    function deposit() public payable nonReentrant {
        if (msg.value == 0) revert ZeroAmount();
        vaults[msg.sender].collateral += msg.value;
        totalCollateral += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice Mint new EUSD against your locked ETH. Your vault must stay at 150% or more.
    function mint(uint256 amount) public nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Vault storage v = vaults[msg.sender];
        uint256 newDebt = v.debt + amount;
        if (newDebt < MIN_DEBT) revert DustDebt(newDebt);
        uint256 newTotal = totalDebt + amount;
        if (newTotal > debtCeiling) revert CeilingReached(newTotal, debtCeiling);
        v.debt = newDebt;
        totalDebt = newTotal;
        _requireHealthy(v, _price());
        emit Minted(msg.sender, amount);
        eusd.mint(msg.sender, amount);
    }

    /// @notice Lock ETH and mint EUSD in one transaction.
    function depositAndMint(uint256 amount) external payable {
        deposit();
        mint(amount);
    }

    /// @notice Burn your EUSD to pay back your vault's debt. Works even when the price is broken.
    function repay(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Vault storage v = vaults[msg.sender];
        if (amount > v.debt) revert NotEnough(amount, v.debt);
        uint256 left = v.debt - amount;
        if (left != 0 && left < MIN_DEBT) revert DustDebt(left);
        v.debt = left;
        totalDebt -= amount;
        emit Repaid(msg.sender, amount);
        eusd.burn(msg.sender, amount);
    }

    /// @notice Take ETH out of your vault. With debt left, the vault must stay at 150% or more
    ///         (and that needs a good price). With no debt, it always works.
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Vault storage v = vaults[msg.sender];
        if (amount > v.collateral) revert NotEnough(amount, v.collateral);
        v.collateral -= amount;
        totalCollateral -= amount;
        if (v.debt != 0) _requireHealthy(v, _price());
        emit Withdrawn(msg.sender, amount);
        _sendEth(msg.sender, amount);
    }

    // ---------------------------------------------------------------- liquidation

    /// @notice Anyone can fix an unsafe vault: burn `amount` of your EUSD against `user`'s debt and
    ///         receive that value in ETH plus 10%, at most half the debt at once. Below 110% the vault
    ///         must be closed in one go (see below). If the ETH runs out before the debt, the rest is
    ///         written off as `badDebt`, in the open.
    function liquidate(address user, uint256 amount) external nonReentrant returns (uint256 seized) {
        if (amount == 0) revert ZeroAmount();
        Vault storage v = vaults[user];
        uint256 px = _price();
        uint256 value = _value(v.collateral, px);
        uint256 debt = v.debt;
        if (debt == 0 || value * WAD >= debt * MIN_RATIO) revert StillHealthy(_ratio(value, debt));

        if (value * WAD >= debt * (WAD + LIQ_BONUS)) {
            // Normal zone (110% … 150%): repay at most half the debt, get that value + 10% in ETH.
            // Taking 110% for every 100% repaid can never push the vault below 110%, so a normal
            // liquidation can never create bad debt.
            uint256 maxRepay = (debt * CLOSE_FACTOR) / WAD;
            if (amount > maxRepay) revert RepayTooLarge(amount, maxRepay);
            seized = (amount * (WAD + LIQ_BONUS)) / px; // rounds down, in the system's favour
            if (seized > v.collateral) seized = v.collateral; // cannot happen above 110%; kept as a guard
        } else {
            // Closing zone (under 110%): all or nothing. The liquidator takes ALL the ETH and must
            // repay the whole debt if the ETH covers it (the bonus shrinks to what is there), or at
            // least the ETH's value minus 10% if it does not. Otherwise a liquidator could repay a
            // little, keep the full bonus, and leave bad debt that did not need to exist.
            uint256 needed = value >= debt ? debt : Math.ceilDiv(value * WAD, WAD + LIQ_BONUS);
            if (amount > debt) revert RepayTooLarge(amount, debt);
            if (amount < needed) revert RepayTooSmall(amount, needed);
            seized = v.collateral;
        }

        v.collateral -= seized;
        totalCollateral -= seized;
        v.debt = debt - amount;
        totalDebt -= amount;
        uint256 written = 0;
        if (v.collateral == 0 && v.debt != 0) {
            // Nothing left to sell: the rest is bad debt, shown openly.
            written = v.debt;
            badDebt += written;
            totalDebt -= written;
            v.debt = 0;
        }
        emit Liquidated(user, msg.sender, amount, seized, written);
        eusd.burn(msg.sender, amount);
        _sendEth(msg.sender, seized);
    }

    // ---------------------------------------------------------------- views

    /// @notice ETH/USD price with 18 decimals, after every safety check.
    function price() external view returns (uint256) {
        return _price();
    }

    /// @notice A vault's collateral ratio (ETH value ÷ debt) with 18 decimals; 1.5e18 = 150%.
    ///         type(uint256).max when there is no debt.
    function collateralRatio(address user) external view returns (uint256) {
        Vault storage v = vaults[user];
        return _ratio(_value(v.collateral, _price()), v.debt);
    }

    /// @notice True when the vault is below 150% and can be liquidated.
    function isLiquidatable(address user) external view returns (bool) {
        Vault storage v = vaults[user];
        return v.debt != 0 && _value(v.collateral, _price()) * WAD < v.debt * MIN_RATIO;
    }

    /// @notice Dollars of ETH behind each EUSD in circulation, 18 decimals (1.6e18 = $1.60).
    ///         Below 1e18 the coin is not fully backed and will lose its peg.
    function backing() external view returns (uint256) {
        uint256 supply = eusd.totalSupply();
        return supply == 0 ? type(uint256).max : (_value(totalCollateral, _price()) * WAD) / supply;
    }

    // ---------------------------------------------------------------- internals

    /// @dev Reads the feed and refuses anything we cannot trust. `virtual` only so the lesson's
    ///      NaiveDollarEngine can show what goes wrong without these checks.
    function _price() internal view virtual returns (uint256) {
        // `startedAt` is not needed: `updatedAt` is the time the answer was written.
        // slither-disable-next-line unused-return
        (uint80 roundId, int256 answer, , uint256 updatedAt, uint80 answeredInRound) = feed.latestRoundData();
        // On or outside the band means the feed is clamping: the real price may be far away.
        if (answer <= _feedMin || answer >= _feedMax) revert PriceOutOfBounds(answer);
        // solhint-disable-next-line not-rely-on-time
        if (updatedAt == 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > MAX_PRICE_AGE) {
            revert StalePrice(updatedAt, block.timestamp); // solhint-disable-line not-rely-on-time
        }
        if (answeredInRound < roundId) revert IncompleteRound(roundId, answeredInRound);
        return uint256(answer) * _scale;
    }

    function _value(uint256 collateral, uint256 price_) internal pure returns (uint256) {
        return (collateral * price_) / WAD; // rounds down: the system never over-values ETH
    }

    function _ratio(uint256 value, uint256 debt) internal pure returns (uint256) {
        return debt == 0 ? type(uint256).max : (value * WAD) / debt;
    }

    function _requireHealthy(Vault storage v, uint256 price_) internal view {
        uint256 value = _value(v.collateral, price_);
        if (value * WAD < v.debt * MIN_RATIO) revert Unhealthy(_ratio(value, v.debt));
    }

    function _sendEth(address to, uint256 amount) internal {
        // Only ever the caller: the vault owner in withdraw(), the liquidator in liquidate().
        // slither-disable-next-line arbitrary-send-eth,low-level-calls
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }
}
