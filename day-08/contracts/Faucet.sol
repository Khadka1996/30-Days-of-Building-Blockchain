// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title Faucet
/// @author Manish Khadka
/// @notice Gives a small amount of one ERC-20 token to anyone who asks, at most once every
///         24 hours per address.
///
///         The danger with any faucet is "many addresses": creating a new address is free, so
///         a per-address limit alone does not stop one person with 10,000 addresses. That is
///         why the faucet also has a **daily budget**: the total it gives out in one UTC day.
///         When the budget is used up, everyone waits for tomorrow. An attacker can take at
///         most one day's budget per day, never the whole faucet.
/// @dev Tokens always go to `msg.sender`. State is written before the transfer (CEI).
contract Faucet is Ownable2Step, Pausable {
    using SafeERC20 for IERC20;

    /// @notice Time an address must wait between two claims.
    uint256 public constant COOLDOWN = 1 days;

    /// @notice The token this faucet hands out. Fixed forever at deploy.
    /// @dev Kept as `token()` (the name every wallet and script expects) instead of TOKEN.
    // solhint-disable-next-line immutable-vars-naming
    IERC20 public immutable token;

    /// @notice Tokens given per claim.
    uint256 public dripAmount;
    /// @notice Most tokens the faucet will give out in one UTC day (all addresses together).
    uint256 public dailyBudget;

    /// @notice When each address last claimed (0 = never).
    mapping(address account => uint256 timestamp) public lastClaimAt;
    /// @notice The UTC day number (block.timestamp / 1 days) the counter below belongs to.
    uint256 public currentDay;
    /// @notice Tokens given out so far during `currentDay`.
    uint256 public givenToday;

    event Claimed(address indexed account, uint256 amount, uint256 nextClaimAt);
    event LimitsChanged(uint256 dripAmount, uint256 dailyBudget);
    event Withdrawn(address indexed to, uint256 amount);

    error ZeroAddress();
    error BadLimits();
    error TooSoon(uint256 nextClaimAt);
    error DailyBudgetUsed(uint256 nextDayStartsAt);
    error FaucetEmpty();

    /// @param token_ The ERC-20 token to give out.
    /// @param dripAmount_ Tokens per claim.
    /// @param dailyBudget_ Most tokens per UTC day, for all addresses together.
    constructor(IERC20 token_, uint256 dripAmount_, uint256 dailyBudget_) Ownable(msg.sender) {
        if (address(token_) == address(0)) revert ZeroAddress();
        token = token_;
        _setLimits(dripAmount_, dailyBudget_);
    }

    // ------------------------------------------------------------------------------------
    // Anyone
    // ------------------------------------------------------------------------------------

    /// @notice Get `dripAmount` tokens. Works once every 24 hours per address, and only while
    ///         today's budget is not used up.
    function claim() external whenNotPaused {
        address account = msg.sender;
        uint256 amount = dripAmount;

        // 1. Checks
        uint256 last = lastClaimAt[account];
        if (last != 0 && block.timestamp < last + COOLDOWN) revert TooSoon(last + COOLDOWN);

        uint256 today = block.timestamp / 1 days;
        // A new UTC day starts at zero. (Time only moves forward, so today >= currentDay.)
        uint256 given = today > currentDay ? 0 : givenToday;
        if (given + amount > dailyBudget) revert DailyBudgetUsed((today + 1) * 1 days);
        if (token.balanceOf(address(this)) < amount) revert FaucetEmpty();

        // 2. Effects (written before any token moves)
        lastClaimAt[account] = block.timestamp;
        currentDay = today;
        givenToday = given + amount;

        emit Claimed(account, amount, block.timestamp + COOLDOWN);

        // 3. Interaction (last)
        token.safeTransfer(account, amount);
    }

    /// @notice How long `account` still has to wait, in seconds (0 = can claim now, as far
    ///         as its own cooldown goes).
    function waitTime(address account) external view returns (uint256) {
        // A never-used address has last = 0, so last + COOLDOWN is long past: wait 0.
        uint256 readyAt = lastClaimAt[account] + COOLDOWN;
        return block.timestamp >= readyAt ? 0 : readyAt - block.timestamp;
    }

    /// @notice Tokens still available today before the daily budget is used up.
    function remainingToday() external view returns (uint256) {
        uint256 given = block.timestamp / 1 days > currentDay ? 0 : givenToday;
        return given >= dailyBudget ? 0 : dailyBudget - given;
    }

    // ------------------------------------------------------------------------------------
    // Owner
    // ------------------------------------------------------------------------------------

    /// @notice Change the drip and the daily budget. A drip must be > 0 and fit in the budget.
    function setLimits(uint256 dripAmount_, uint256 dailyBudget_) external onlyOwner {
        _setLimits(dripAmount_, dailyBudget_);
    }

    /// @notice Stop claims (for example while an attack is going on).
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Start claims again.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Take tokens back out of the faucet (for example to close it).
    function withdraw(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        emit Withdrawn(to, amount);
        token.safeTransfer(to, amount);
    }

    function _setLimits(uint256 dripAmount_, uint256 dailyBudget_) private {
        if (dripAmount_ == 0 || dailyBudget_ < dripAmount_) revert BadLimits();
        dripAmount = dripAmount_;
        dailyBudget = dailyBudget_;
        emit LimitsChanged(dripAmount_, dailyBudget_);
    }
}
