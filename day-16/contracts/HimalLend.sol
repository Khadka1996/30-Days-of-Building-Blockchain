// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice The Chainlink AggregatorV3 functions HimalLend needs.
interface IPriceFeed {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title HimalLend — a mini lending pool
/// @author Manish Khadka
/// @notice Lenders deposit HUSD and earn interest. Borrowers lock HIM as collateral and borrow HUSD
///         against it, up to 75% of its value. If the collateral falls to where the debt is more than
///         80% of its value, anyone can liquidate: repay part of the debt and take that much collateral
///         plus a 5% bonus. If the collateral is worth less than the debt, the loss is written off
///         openly (reserves first, then lenders pro-rata) instead of hiding in the books.
/// @dev    Two kinds of shares:
///         - lender shares: a claim on `totalAssets()` (cash + debt owed - reserves), like a cToken;
///         - debt shares:   debt = debtShares × borrowIndex. The index grows with interest, so every
///                          borrower's debt grows without touching each account (like Day 15's
///                          reward-per-token). Debt always rounds UP, payouts always round DOWN.
///         Prices come from a Chainlink-style feed, never from a pool's spot price, and stale or
///         broken prices are refused.
contract HimalLend is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- settings
    uint256 public constant WAD = 1e18;
    uint256 public constant MAX_LTV = 0.75e18; // borrow up to 75% of collateral value
    uint256 public constant LIQ_THRESHOLD = 0.8e18; // liquidatable once debt > 80% of collateral value
    uint256 public constant LIQ_BONUS = 0.05e18; // liquidators get 5% extra collateral
    uint256 public constant CLOSE_FACTOR = 0.5e18; // at most 50% of a debt per liquidation...
    // ...unless the collateral cannot cover the debt plus bonus: then the whole debt can be closed.
    uint256 public constant RESERVE_FACTOR = 0.1e18; // 10% of interest goes to reserves
    uint256 public constant MAX_PRICE_AGE = 1 hours;

    // Interest rate model (per year), with a "kink" like Compound and Aave:
    // 2% at 0% utilisation, rising to 10% at 80%, then steeply to 100% at full utilisation,
    // so that lenders can almost always get their money out.
    uint256 public constant BASE_RATE = 0.02e18;
    uint256 public constant KINK = 0.8e18;
    uint256 public constant RATE_AT_KINK = 0.1e18;
    uint256 public constant MAX_RATE = 1e18;
    uint256 public constant YEAR = 365 days;

    // Virtual shares/assets make the first-depositor share-price attack unprofitable (Day 20 goes deeper).
    uint256 private constant VIRTUAL_SHARES = 1e6;
    uint256 private constant VIRTUAL_ASSETS = 1;

    // solhint-disable-next-line immutable-vars-naming
    IERC20 public immutable asset; // HUSD: lent and borrowed
    // solhint-disable-next-line immutable-vars-naming
    IERC20 public immutable collateral; // HIM: locked by borrowers
    // solhint-disable-next-line immutable-vars-naming
    IPriceFeed public immutable priceFeed; // HUSD per 1 HIM
    // solhint-disable-next-line immutable-vars-naming
    uint256 public immutable priceScale; // 10 ** feed decimals

    // ---------------------------------------------------------------- state
    uint256 public totalCash; // HUSD the pool holds for lenders (tracked, so donations change nothing)
    uint256 public reserves; // part of the interest kept by the protocol; first to absorb bad debt
    uint256 public totalBadDebt; // all debt ever written off
    uint256 public totalShares; // lender shares
    uint256 public totalDebtShares; // borrower debt shares
    uint256 public borrowIndex = WAD; // HUSD owed per debt share (1e18 = 1.0)
    uint256 public lastAccrual;

    mapping(address => uint256) public sharesOf;
    mapping(address => uint256) public collateralOf;
    mapping(address => uint256) public debtSharesOf;

    // ---------------------------------------------------------------- events and errors
    event Deposit(address indexed lender, uint256 assets, uint256 shares);
    event Redeem(address indexed lender, uint256 assets, uint256 shares);
    event CollateralDeposited(address indexed borrower, uint256 amount);
    event CollateralWithdrawn(address indexed borrower, uint256 amount);
    event Borrow(address indexed borrower, uint256 amount);
    event Repay(address indexed payer, address indexed borrower, uint256 amount);
    event Liquidate(address indexed liquidator, address indexed borrower, uint256 repaid, uint256 seized);
    event BadDebtWrittenOff(address indexed borrower, uint256 amount, uint256 fromReserves, uint256 fromLenders);
    event Accrue(uint256 interest, uint256 borrowIndex, uint256 reserves);
    event ReservesWithdrawn(address indexed to, uint256 amount);

    error ZeroAddress();
    error SameToken();
    error ZeroAmount();
    error InsufficientCash();
    error InsufficientCollateral();
    error Unhealthy();
    error NotLiquidatable();
    error StalePrice();
    error BadPrice();
    error TokenMismatch();
    error DecimalsMismatch();

    constructor(IERC20 asset_, IERC20 collateral_, IPriceFeed feed_, address owner_) Ownable(owner_) {
        if (address(asset_) == address(0) || address(collateral_) == address(0) || address(feed_) == address(0)) {
            revert ZeroAddress();
        }
        if (address(asset_) == address(collateral_)) revert SameToken();
        // Values are computed as amount x price, so both tokens must use the same number of decimals.
        if (IERC20Metadata(address(asset_)).decimals() != IERC20Metadata(address(collateral_)).decimals()) {
            revert DecimalsMismatch();
        }
        asset = asset_;
        collateral = collateral_;
        priceFeed = feed_;
        priceScale = 10 ** feed_.decimals();
        lastAccrual = block.timestamp;
    }

    // ================================================================ lenders

    /// @notice Lend HUSD. You get shares; they are worth more HUSD over time as interest comes in.
    function deposit(uint256 amount) external nonReentrant returns (uint256 shares) {
        if (amount == 0) revert ZeroAmount();
        accrue();
        shares = Math.mulDiv(amount, totalShares + VIRTUAL_SHARES, totalAssets() + VIRTUAL_ASSETS);
        if (shares == 0) revert ZeroAmount();
        _pullExact(asset, amount);
        totalCash += amount;
        totalShares += shares;
        sharesOf[msg.sender] += shares;
        emit Deposit(msg.sender, amount, shares);
    }

    /// @notice Turn shares back into HUSD (rounded down). Only cash that is not lent out can leave.
    function redeem(uint256 shares) external nonReentrant returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();
        accrue();
        assets = previewRedeem(shares);
        if (assets == 0) revert ZeroAmount();
        if (assets > totalCash) revert InsufficientCash();
        sharesOf[msg.sender] -= shares; // reverts if you do not have them
        totalShares -= shares;
        totalCash -= assets;
        asset.safeTransfer(msg.sender, assets);
        emit Redeem(msg.sender, assets, shares);
    }

    // ================================================================ borrowers

    /// @notice Lock HIM as collateral.
    function depositCollateral(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _pullExact(collateral, amount);
        collateralOf[msg.sender] += amount;
        emit CollateralDeposited(msg.sender, amount);
    }

    /// @notice Take HIM back. With debt, what stays must still cover it at 75% LTV.
    function withdrawCollateral(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        accrue();
        if (amount > collateralOf[msg.sender]) revert InsufficientCollateral();
        collateralOf[msg.sender] -= amount;
        if (debtSharesOf[msg.sender] != 0 && debtOf(msg.sender) > maxBorrow(msg.sender)) revert Unhealthy();
        collateral.safeTransfer(msg.sender, amount);
        emit CollateralWithdrawn(msg.sender, amount);
    }

    /// @notice Borrow HUSD against your collateral, up to 75% of its value.
    function borrow(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        accrue();
        if (amount > totalCash) revert InsufficientCash();
        // Debt shares round UP: borrowing 1 wei always creates at least 1 wei of debt.
        uint256 shares = Math.mulDiv(amount, WAD, borrowIndex, Math.Rounding.Ceil);
        debtSharesOf[msg.sender] += shares;
        totalDebtShares += shares;
        if (debtOf(msg.sender) > maxBorrow(msg.sender)) revert Unhealthy();
        totalCash -= amount;
        asset.safeTransfer(msg.sender, amount);
        emit Borrow(msg.sender, amount);
    }

    /// @notice Repay HUSD for `borrower` (yourself or someone else). Pass type(uint256).max to repay all.
    function repay(address borrower, uint256 amount) external nonReentrant returns (uint256 repaid) {
        if (amount == 0) revert ZeroAmount();
        accrue();
        uint256 debt = debtOf(borrower);
        repaid = amount > debt ? debt : amount;
        if (repaid == 0) revert ZeroAmount();
        _pullExact(asset, repaid);
        _reduceDebt(borrower, repaid, debt);
        emit Repay(msg.sender, borrower, repaid);
    }

    // ================================================================ liquidation

    /// @notice Repay part of an unhealthy borrower's debt and receive that value in HIM plus 5%.
    /// @param  maxRepay the most HUSD you are willing to repay (the pool may take less).
    function liquidate(address borrower, uint256 maxRepay) external nonReentrant returns (uint256 repaid, uint256 seized) {
        if (maxRepay == 0) revert ZeroAmount();
        accrue();
        uint256 price = _price();
        uint256 debt = debtOf(borrower);
        uint256 coll = collateralOf[borrower];
        uint256 collValue = Math.mulDiv(coll, price, priceScale);
        if (debt == 0 || Math.mulDiv(collValue, LIQ_THRESHOLD, WAD) >= debt) revert NotLiquidatable();

        // Normally only half the debt can be closed at once. If the collateral cannot even cover
        // the debt plus the bonus, the whole debt can be closed so bad debt is dealt with now.
        bool underwater = Math.mulDiv(collValue, WAD, WAD + LIQ_BONUS) <= debt;
        uint256 limit = underwater ? debt : Math.mulDiv(debt, CLOSE_FACTOR, WAD);
        repaid = maxRepay < limit ? maxRepay : limit;

        // Collateral to give = repaid × 1.05 / price (rounded down, in the pool's favour).
        seized = Math.mulDiv(Math.mulDiv(repaid, WAD + LIQ_BONUS, WAD), priceScale, price);
        if (seized > coll) {
            seized = coll;
            // Only charge the liquidator for what the collateral is worth (rounded up for the pool).
            repaid = Math.mulDiv(collValue, WAD, WAD + LIQ_BONUS, Math.Rounding.Ceil);
            if (repaid > debt) repaid = debt;
        }
        if (repaid == 0) revert ZeroAmount();

        _pullExact(asset, repaid);
        _reduceDebt(borrower, repaid, debt);
        collateralOf[borrower] = coll - seized;
        emit Liquidate(msg.sender, borrower, repaid, seized);

        // No collateral left but debt remains: nobody will ever repay it. Write it off openly.
        if (collateralOf[borrower] == 0 && debtSharesOf[borrower] != 0) _writeOff(borrower);

        collateral.safeTransfer(msg.sender, seized);
    }

    // ================================================================ interest

    /// @notice Add the interest owed since the last update. Every action calls this first.
    function accrue() public {
        uint256 elapsed = block.timestamp - lastAccrual;
        // Comparing our own timestamps: nothing an attacker controls. Already up to date this block.
        // slither-disable-next-line incorrect-equality
        if (elapsed == 0) return;
        lastAccrual = block.timestamp;
        if (totalDebtShares == 0) return;
        uint256 rate = borrowRatePerYear(utilization());
        uint256 oldDebt = totalDebt();
        borrowIndex += Math.mulDiv(borrowIndex, rate * elapsed, YEAR * WAD);
        uint256 interest = totalDebt() - oldDebt;
        reserves += Math.mulDiv(interest, RESERVE_FACTOR, WAD);
        emit Accrue(interest, borrowIndex, reserves);
    }

    /// @notice Owner takes reserves (never lenders' money): at most `reserves`, and only from cash.
    function withdrawReserves(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        accrue();
        if (amount == 0 || amount > reserves) revert ZeroAmount();
        if (amount > totalCash) revert InsufficientCash();
        reserves -= amount;
        totalCash -= amount;
        asset.safeTransfer(to, amount);
        emit ReservesWithdrawn(to, amount);
    }

    // ================================================================ views

    /// @notice HUSD that belongs to lenders: cash in the pool + what borrowers owe − reserves.
    function totalAssets() public view returns (uint256) {
        return totalCash + totalDebt() - reserves;
    }

    /// @notice All borrower debt at the last accrual (rounded up).
    function totalDebt() public view returns (uint256) {
        return Math.mulDiv(totalDebtShares, borrowIndex, WAD, Math.Rounding.Ceil);
    }

    /// @notice A borrower's debt at the last accrual (rounded up). Call accrue() first for a fresh value.
    function debtOf(address borrower) public view returns (uint256) {
        return Math.mulDiv(debtSharesOf[borrower], borrowIndex, WAD, Math.Rounding.Ceil);
    }

    /// @notice Value of a borrower's collateral in HUSD at the oracle price.
    function collateralValue(address borrower) public view returns (uint256) {
        return Math.mulDiv(collateralOf[borrower], _price(), priceScale);
    }

    /// @notice The most this borrower may owe after borrowing or withdrawing collateral (75% LTV).
    function maxBorrow(address borrower) public view returns (uint256) {
        return Math.mulDiv(collateralValue(borrower), MAX_LTV, WAD);
    }

    /// @notice Health factor: collateral value × 80% ÷ debt (1e18 = 1.0). Below 1.0 = liquidatable.
    function healthFactor(address borrower) external view returns (uint256) {
        uint256 debt = debtOf(borrower);
        if (debt == 0) return type(uint256).max;
        return Math.mulDiv(Math.mulDiv(collateralValue(borrower), LIQ_THRESHOLD, WAD), WAD, debt);
    }

    /// @notice Share of lenders' money that is lent out (1e18 = 100%).
    function utilization() public view returns (uint256) {
        uint256 debt = totalDebt();
        if (debt == 0) return 0;
        uint256 supplied = totalCash + debt - reserves;
        if (supplied == 0) return WAD;
        uint256 u = Math.mulDiv(debt, WAD, supplied);
        return u > WAD ? WAD : u;
    }

    /// @notice Yearly borrow rate for a given utilisation (the "kinked" model).
    function borrowRatePerYear(uint256 u) public pure returns (uint256) {
        if (u <= KINK) return BASE_RATE + Math.mulDiv(RATE_AT_KINK - BASE_RATE, u, KINK);
        return RATE_AT_KINK + Math.mulDiv(MAX_RATE - RATE_AT_KINK, u - KINK, WAD - KINK);
    }

    /// @notice Yearly rate lenders earn right now: borrow rate × utilisation × 90%.
    function supplyRatePerYear() external view returns (uint256) {
        uint256 u = utilization();
        return Math.mulDiv(Math.mulDiv(borrowRatePerYear(u), u, WAD), WAD - RESERVE_FACTOR, WAD);
    }

    /// @notice HUSD you would get for `shares` (rounded down).
    function previewRedeem(uint256 shares) public view returns (uint256) {
        return Math.mulDiv(shares, totalAssets() + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
    }

    // ================================================================ internals

    /// @dev Oracle price with safety checks: positive, not from the future, at most 1 hour old.
    function _price() internal view returns (uint256) {
        // Only the price and its time matter; round ids are deprecated in Chainlink's own docs.
        // slither-disable-next-line unused-return
        (, int256 answer,, uint256 updatedAt,) = priceFeed.latestRoundData();
        if (answer <= 0) revert BadPrice();
        if (updatedAt > block.timestamp || block.timestamp - updatedAt > MAX_PRICE_AGE) revert StalePrice();
        return uint256(answer);
    }

    /// @dev Burns debt shares worth `amount` (rounded down, so the borrower never pays less than owed).
    function _reduceDebt(address borrower, uint256 amount, uint256 debt) internal {
        uint256 shares = amount == debt ? debtSharesOf[borrower] : Math.mulDiv(amount, WAD, borrowIndex);
        debtSharesOf[borrower] -= shares;
        totalDebtShares -= shares;
        totalCash += amount;
    }

    /// @dev Removes debt that can never be repaid. Reserves absorb it first; the rest lowers every
    ///      lender's share value equally, so nobody can rush out and leave the loss to the last lender.
    function _writeOff(address borrower) internal {
        uint256 loss = debtOf(borrower);
        uint256 shares = debtSharesOf[borrower];
        uint256 debtBefore = totalDebt();
        debtSharesOf[borrower] = 0;
        totalDebtShares -= shares;
        // Use the real drop in totalDebt (rounding can make it 1 wei off `loss`).
        uint256 drop = debtBefore - totalDebt();
        uint256 fromReserves = drop < reserves ? drop : reserves;
        reserves -= fromReserves;
        totalBadDebt += loss;
        emit BadDebtWrittenOff(borrower, loss, fromReserves, drop - fromReserves);
    }

    /// @dev Pulls exactly `amount`. Fee-on-transfer and other odd tokens are refused, not mis-booked.
    function _pullExact(IERC20 token, uint256 amount) internal {
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        if (token.balanceOf(address(this)) - before != amount) revert TokenMismatch();
    }
}
