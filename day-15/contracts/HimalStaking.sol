// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title HimalStaking — lock HIM tokens, earn HRW rewards every second
/// @author Manish Khadka (30 Days of Building Blockchain, Day 15)
/// @notice The owner puts a pot of rewards in and picks how long it lasts (for example
///         70,000 HRW over 7 days = 0.1157 HRW per second). Every second, that second's
///         rewards are shared between everyone staked at that moment, in proportion to
///         how much they have staked.
/// @dev The "reward per token" trick (Synthetix StakingRewards): instead of updating every
///      staker every second, keep one running total `rewardPerTokenStored` = rewards earned
///      by 1 staked token since the start. A staker's reward is
///      balance × (rewardPerToken now − rewardPerToken when they last settled).
///      Differences from the classic version (see QA.md):
///      - the reward rate and reward per token are scaled by 1e36 (not 1e18), so small or
///        long reward periods, 6-decimal reward tokens and "poke every block" griefing do
///        not round rewards away (F-01, F-07);
///      - rewards for seconds when nobody is staked are kept and rolled into the next
///        period instead of being stuck forever (F-03);
///      - only tokens that really arrived are counted (fee-on-transfer safe) (F-04);
///      - staking and reward token must differ, and the owner can never take either (F-05).
contract HimalStaking is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Fixed-point scale used for the reward rate and reward per token.
    /// @dev 1e36, not the usual 1e18: with 1e18, each update loses up to
    ///      totalStaked / 1e18 reward units, which is 0.001 USDC per update for only
    ///      1,000 staked tokens (QA.md F-07). Overflow is not a concern for any real supply:
    ///      reward × 1e36 fits in uint256 for rewards up to 1e41 units.
    uint256 public constant PRECISION = 1e36;
    uint256 public constant MIN_DURATION = 1 days;
    uint256 public constant MAX_DURATION = 365 days;


    // solhint-disable-next-line immutable-vars-naming
    IERC20 public immutable stakingToken;
    // solhint-disable-next-line immutable-vars-naming
    IERC20 public immutable rewardsToken;

    /// @notice When the current reward period ends (unix time).
    uint256 public periodFinish;
    /// @notice Reward tokens paid out per second, multiplied by PRECISION.
    uint256 public rewardRateScaled;
    /// @notice Last time `rewardPerTokenStored` was brought up to date.
    uint256 public lastUpdateTime;
    /// @notice Rewards earned per unit (wei) of staked token so far, multiplied by PRECISION.
    uint256 public rewardPerTokenStored;
    /// @notice Rewards (× PRECISION) for seconds when nobody was staked; added to the next period.
    uint256 public unallocatedScaled;

    uint256 public totalStaked;
    mapping(address => uint256) public balanceOf;
    /// @notice `rewardPerToken` at the moment this account last settled.
    mapping(address => uint256) public userRewardPerTokenPaid;
    /// @notice Rewards settled for this account but not yet claimed.
    mapping(address => uint256) public rewards;

    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 reward);
    event RewardAdded(uint256 reward, uint256 duration, uint256 rewardRateScaled, uint256 periodFinish);
    event Recovered(address indexed token, uint256 amount);

    error ZeroAddress();
    error SameToken();
    error ZeroAmount();
    error InsufficientBalance(uint256 requested, uint256 available);
    error BadDuration(uint256 duration);
    error CannotRecoverThisToken();

    constructor(address stakingToken_, address rewardsToken_, address owner_) Ownable(owner_) {
        if (stakingToken_ == address(0) || rewardsToken_ == address(0)) revert ZeroAddress();
        if (stakingToken_ == rewardsToken_) revert SameToken();
        stakingToken = IERC20(stakingToken_);
        rewardsToken = IERC20(rewardsToken_);
    }

    // ───────────────────────────── views ─────────────────────────────

    /// @notice Rewards stop growing when the period ends.
    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    /// @notice Rewards earned per unit of staked token since the start (× PRECISION).
    function rewardPerToken() public view returns (uint256) {
        // slither-disable-next-line incorrect-equality
        if (totalStaked == 0) return rewardPerTokenStored;
        uint256 elapsed = lastTimeRewardApplicable() - lastUpdateTime;
        return rewardPerTokenStored + (elapsed * rewardRateScaled) / totalStaked;
    }

    /// @notice Rewards `account` could claim right now.
    function earned(address account) public view returns (uint256) {
        return rewards[account]
            + (balanceOf[account] * (rewardPerToken() - userRewardPerTokenPaid[account])) / PRECISION;
    }

    /// @notice Reward tokens paid per second (rounded down, for display).
    function rewardRate() external view returns (uint256) {
        return rewardRateScaled / PRECISION;
    }

    // ─────────────────────────── staker actions ───────────────────────────

    /// @notice Lock `amount` HIM. You start earning from the next second.
    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _updateReward(msg.sender);
        // Count what really arrived (a fee-on-transfer token delivers less than `amount`).
        uint256 received = _pull(stakingToken, amount);
        // slither-disable-next-line incorrect-equality
        if (received == 0) revert ZeroAmount();
        totalStaked += received;
        balanceOf[msg.sender] += received;
        emit Staked(msg.sender, received);
    }

    /// @notice Take back `amount` of your staked HIM. Always possible: there is no pause.
    function withdraw(uint256 amount) public nonReentrant {
        _withdraw(amount);
    }

    /// @notice Claim all rewards earned so far.
    function getReward() public nonReentrant {
        _getReward();
    }

    /// @notice Withdraw everything and claim all rewards in one call.
    function exit() external nonReentrant {
        uint256 bal = balanceOf[msg.sender];
        if (bal > 0) _withdraw(bal);
        _getReward();
    }

    // ─────────────────────────── owner actions ───────────────────────────

    /// @notice Add `reward` HRW to be paid out evenly over the next `duration` seconds.
    ///         Rewards still unpaid from the current period (and from seconds when nobody
    ///         was staked) are added on top, so nothing is lost.
    function notifyRewardAmount(uint256 reward, uint256 duration) external onlyOwner nonReentrant {
        if (reward == 0) revert ZeroAmount();
        if (duration < MIN_DURATION || duration > MAX_DURATION) revert BadDuration(duration);
        _updateReward(address(0));

        // Pull the reward first: the contract can never promise tokens it does not hold.
        uint256 received = _pull(rewardsToken, reward);
        // slither-disable-next-line incorrect-equality
        if (received == 0) revert ZeroAmount();

        uint256 totalScaled = received * PRECISION + unallocatedScaled;
        unallocatedScaled = 0;
        if (block.timestamp < periodFinish) {
            // Carry over what is still unpaid. rewardRateScaled was itself a division, but at
            // 1e36 scale the rounding is far below 1 unit of the token (slither: by design).
            // slither-disable-next-line divide-before-multiply
            totalScaled += (periodFinish - block.timestamp) * rewardRateScaled;
        }

        // Never 0: received ≥ 1 unit, so totalScaled ≥ 1e36, and duration ≤ 365 days ≈ 3.2e7.
        uint256 newRate = totalScaled / duration;

        rewardRateScaled = newRate;
        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + duration;
        emit RewardAdded(received, duration, newRate, block.timestamp + duration);
    }

    /// @notice Rescue tokens sent here by mistake. Never the staked HIM or the HRW rewards.
    function recoverERC20(address token, uint256 amount) external onlyOwner {
        if (token == address(stakingToken) || token == address(rewardsToken)) revert CannotRecoverThisToken();
        IERC20(token).safeTransfer(owner(), amount);
        emit Recovered(token, amount);
    }

    // ───────────────────────────── internals ─────────────────────────────

    /// @dev Bring the global total up to date, then settle `account` (skip for address(0)).
    function _updateReward(address account) internal {
        uint256 applicable = lastTimeRewardApplicable();
        uint256 elapsed = applicable - lastUpdateTime;
        if (elapsed > 0) {
            if (totalStaked == 0) {
                // Nobody staked: keep these rewards for the next period (F-03).
                unallocatedScaled += elapsed * rewardRateScaled;
            } else {
                rewardPerTokenStored += (elapsed * rewardRateScaled) / totalStaked;
            }
        }
        lastUpdateTime = applicable;

        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
    }

    function _withdraw(uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = balanceOf[msg.sender];
        if (amount > bal) revert InsufficientBalance(amount, bal);
        _updateReward(msg.sender);
        // Effects before the transfer (checks → effects → interaction).
        balanceOf[msg.sender] = bal - amount;
        totalStaked -= amount;
        stakingToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function _getReward() internal {
        _updateReward(msg.sender);
        uint256 reward = rewards[msg.sender];
        if (reward > 0) {
            rewards[msg.sender] = 0;
            rewardsToken.safeTransfer(msg.sender, reward);
            emit RewardPaid(msg.sender, reward);
        }
    }

    /// @dev Transfer `amount` in from the caller and return what actually arrived.
    function _pull(IERC20 token, uint256 amount) internal returns (uint256) {
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        return token.balanceOf(address(this)) - before;
    }
}
