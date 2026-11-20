// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IStrategy {
    function asset() external view returns (IERC20);
    function totalAssets() external view returns (uint256);
    function deposit(uint256 amount) external;
    function withdraw(uint256 amount) external;
}

/// @title YieldVault — Himal Yield HUSD (hyHUSD), an ERC-4626 vault
/// @notice Deposit HUSD, get vault shares. The vault keeps 10% as cash and invests the rest in a
///         strategy. When the strategy earns interest, each share is worth more HUSD, so every
///         depositor earns in proportion to their shares.
///
///         Protections against the first-depositor inflation attack and profit sniping:
///         1. Virtual shares: 6 extra decimals (`_decimalsOffset`), so a tiny first deposit
///            cannot set a huge share price.
///         2. Own bookkeeping: the vault counts its cash (`idle`) itself, so HUSD sent directly
///            to it is ignored.
///         3. Profit lock: new profit unlocks bit by bit over `profitUnlockTime`, so nobody can
///            jump in just before a harvest and take the profit others waited for.
///         4. Losses count at once, and deposits that would give 0 shares are refused.
///         5. `depositWithMin` / `redeemWithMin`: slippage limits for people who want them.
///
///         The vault has no owner and no admin functions.
contract YieldVault is ERC4626, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant WAD = 1e18;
    /// @notice Share of total assets kept as cash for withdrawals (10%).
    uint256 public constant IDLE_BUFFER = 0.1e18;
    uint256 public constant MAX_UNLOCK_TIME = 30 days;

    // Lower-case names so the public getters read like a normal vault API.
    // solhint-disable immutable-vars-naming
    IStrategy public immutable strategy;
    uint256 public immutable profitUnlockTime;
    // solhint-enable immutable-vars-naming

    /// @notice HUSD held by the vault as cash, as counted by the vault (not its balance).
    uint256 public idle;
    /// @notice HUSD in the strategy as of the last harvest, invest or withdrawal.
    uint256 public strategyAssets;
    /// @notice Profit still locked right after the last harvest, when that was, and when it
    ///         will be fully unlocked. Locked profit falls in a straight line to 0 at `unlockEnd`.
    uint256 public lockedAtHarvest;
    uint256 public lastHarvest;
    uint256 public unlockEnd;

    event Invested(uint256 amount);
    event Harvested(uint256 profit, uint256 loss, uint256 locked);

    error ZeroAddress();
    error WrongAsset();
    error BadUnlockTime(uint256 unlockTime);
    error ZeroShares();
    error ZeroAmount();
    error NothingToInvest();
    error TooFewShares(uint256 shares, uint256 minShares);
    error TooFewAssets(uint256 assets, uint256 minAssets);

    constructor(IERC20 asset_, IStrategy strategy_, uint256 profitUnlockTime_)
        ERC20("Himal Yield HUSD", "hyHUSD")
        ERC4626(asset_)
    {
        if (address(strategy_) == address(0)) revert ZeroAddress();
        if (strategy_.asset() != asset_) revert WrongAsset();
        if (profitUnlockTime_ == 0 || profitUnlockTime_ > MAX_UNLOCK_TIME) revert BadUnlockTime(profitUnlockTime_);
        strategy = strategy_;
        profitUnlockTime = profitUnlockTime_;
        lastHarvest = block.timestamp;
        unlockEnd = block.timestamp;
    }

    // ---------------------------------------------------------------- accounting

    /// @notice Profit from the last harvest that has not unlocked yet (falls linearly to 0).
    function lockedProfit() public view returns (uint256) {
        if (block.timestamp >= unlockEnd) return 0;
        return (lockedAtHarvest * (unlockEnd - block.timestamp)) / (unlockEnd - lastHarvest);
    }

    /// @notice HUSD that belongs to the shareholders right now:
    ///         cash + strategy - profit still locked. A loss in the strategy counts at once
    ///         (it first eats the locked profit, exactly like `harvest` would); new profit counts
    ///         only after a harvest, and then unlocks slowly.
    function totalAssets() public view override returns (uint256) {
        (uint256 inStrategy, uint256 locked) = _strategyView();
        return idle + inStrategy - locked;
    }

    function _strategyView() private view returns (uint256 inStrategy, uint256 locked) {
        inStrategy = strategy.totalAssets();
        locked = lockedProfit();
        if (inStrategy < strategyAssets) {
            uint256 loss = strategyAssets - inStrategy;
            locked = loss >= locked ? 0 : locked - loss;
        } else {
            inStrategy = strategyAssets; // unharvested profit is not counted yet
        }
    }

    // ---------------------------------------------------------------- keeper functions (anyone)

    /// @notice Move cash above the 10% buffer into the strategy. Anyone can call it.
    function invest() external nonReentrant returns (uint256 amount) {
        uint256 target = (totalAssets() * IDLE_BUFFER) / WAD;
        if (idle <= target) revert NothingToInvest();
        amount = idle - target;
        idle -= amount;
        strategyAssets += amount;
        emit Invested(amount);
        IERC20(asset()).forceApprove(address(strategy), amount);
        strategy.deposit(amount);
    }

    /// @notice Record the strategy's profit or loss. Profit is locked and unlocks over
    ///         `profitUnlockTime`; a loss first eats locked profit. Anyone can call it.
    /// @dev The new end time is the average of the old remaining time and a full unlock time,
    ///      weighted by amount. So a 1-wei "profit" barely moves it, and calling harvest again
    ///      and again cannot hold real profit back (F-05).
    function harvest() external nonReentrant returns (uint256 profit, uint256 loss) {
        uint256 current = strategy.totalAssets();
        uint256 previous = strategyAssets;
        // slither-disable-next-line incorrect-equality (our own bookkeeping, not a token balance)
        if (current == previous) return (0, 0); // nothing new: do not restart the unlock clock
        uint256 locked = lockedProfit();
        uint256 remaining = unlockEnd > block.timestamp ? unlockEnd - block.timestamp : 0;
        if (current > previous) {
            profit = current - previous;
            // Rounded up, so profit never unlocks early.
            remaining = (locked * remaining + profit * profitUnlockTime + locked + profit - 1) / (locked + profit);
            locked += profit;
        } else {
            loss = previous - current;
            locked = loss >= locked ? 0 : locked - loss;
        }
        strategyAssets = current;
        lockedAtHarvest = locked;
        lastHarvest = block.timestamp;
        unlockEnd = block.timestamp + remaining;
        emit Harvested(profit, loss, locked);
    }

    // ---------------------------------------------------------------- user functions

    function deposit(uint256 assets, address receiver) public override nonReentrant returns (uint256 shares) {
        shares = super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override nonReentrant returns (uint256 assets) {
        assets = super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner)
        public
        override
        nonReentrant
        returns (uint256 shares)
    {
        shares = super.withdraw(assets, receiver, owner);
    }

    function redeem(uint256 shares, address receiver, address owner)
        public
        override
        nonReentrant
        returns (uint256 assets)
    {
        assets = super.redeem(shares, receiver, owner);
    }

    /// @notice `deposit`, but revert unless at least `minShares` shares are received.
    function depositWithMin(uint256 assets, address receiver, uint256 minShares)
        external
        nonReentrant
        returns (uint256 shares)
    {
        shares = super.deposit(assets, receiver);
        if (shares < minShares) revert TooFewShares(shares, minShares);
    }

    /// @notice `redeem`, but revert unless at least `minAssets` HUSD are paid out.
    function redeemWithMin(uint256 shares, address receiver, address owner, uint256 minAssets)
        external
        nonReentrant
        returns (uint256 assets)
    {
        assets = super.redeem(shares, receiver, owner);
        if (assets < minAssets) revert TooFewAssets(assets, minAssets);
    }

    // ---------------------------------------------------------------- internals

    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    // slither-disable-next-line dead-code (an override: OpenZeppelin's deposit/mint call it)
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        // slither-disable-next-line incorrect-equality (zero checks, not balance comparisons)
        if (assets == 0) revert ZeroAmount();
        // slither-disable-next-line incorrect-equality
        if (shares == 0) revert ZeroShares();
        idle += assets;
        super._deposit(caller, receiver, assets, shares);
    }

    // slither-disable-next-line dead-code (an override: OpenZeppelin's withdraw/redeem call it)
    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal
        override
    {
        // slither-disable-next-line incorrect-equality (zero checks, not balance comparisons)
        if (assets == 0 || shares == 0) revert ZeroAmount();
        uint256 cash = idle;
        if (assets > cash) {
            // Not enough cash: bring the rest back from the strategy. Books first, then the call.
            uint256 pull = assets - cash;
            idle = 0;
            strategyAssets -= pull;
            strategy.withdraw(pull);
        } else {
            idle = cash - assets;
        }
        super._withdraw(caller, receiver, owner, assets, shares);
    }
}
