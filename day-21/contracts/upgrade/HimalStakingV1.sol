// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

/// @title HimalStakingV1 — the Day 15 staking contract, made upgradeable with a UUPS proxy
/// @author Manish Khadka (30 Days of Building Blockchain, Day 21)
/// @notice Same rules as Day 15: stake HIM, earn HRW every second. The difference is HOW it is
///         deployed: users talk to a small, fixed proxy that holds all the tokens and storage,
///         and the proxy forwards every call to this "logic" contract. The owner can later point
///         the proxy at a new logic contract (V2) without moving anyone's tokens.
/// @dev UUPS (ERC-1822 / ERC-1967): the upgrade function lives here in the logic contract, not
///      in the proxy. Rules that keep it safe (see QA.md):
///      - no constructor logic: `initialize` runs once, in the same transaction as the proxy
///        is created (F-02), and the logic contract itself is locked with
///        `_disableInitializers()` so nobody can take it over (F-03);
///      - only the owner can upgrade (`_authorizeUpgrade`, F-01);
///      - no `immutable` tokens: they would live in the logic contract's code, not in the
///        proxy's storage, and be lost or wrong after an upgrade;
///      - storage is APPEND-ONLY: a new version may add variables after the last one, never
///        insert, remove, reorder or retype them (F-04). The OpenZeppelin base contracts keep
///        their own variables in separate ERC-7201 "namespaced" slots, so they never clash.
contract HimalStakingV1 is Initializable, OwnableUpgradeable, ReentrancyGuardUpgradeable, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    uint256 public constant PRECISION = 1e36;
    uint256 public constant MIN_DURATION = 1 days;
    uint256 public constant MAX_DURATION = 365 days;

    // ── storage layout v1 (slot numbers in brackets; NEVER change this order) ──
    IERC20 public stakingToken; //          [0]
    IERC20 public rewardsToken; //          [1]
    uint256 public periodFinish; //         [2]
    uint256 public rewardRateScaled; //     [3]
    uint256 public lastUpdateTime; //       [4]
    uint256 public rewardPerTokenStored; // [5]
    uint256 public unallocatedScaled; //    [6]
    uint256 public totalStaked; //          [7]
    mapping(address => uint256) public balanceOf; //              [8]
    mapping(address => uint256) public userRewardPerTokenPaid; // [9]
    mapping(address => uint256) public rewards; //                [10]

    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 reward);
    event RewardAdded(uint256 reward, uint256 duration, uint256 rewardRateScaled, uint256 periodFinish);

    error ZeroAddress();
    error SameToken();
    error ZeroAmount();
    error InsufficientBalance(uint256 requested, uint256 available);
    error BadDuration(uint256 duration);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        // Lock this logic contract: only proxies pointing at it can be initialized (F-03).
        _disableInitializers();
    }

    /// @notice Runs once, inside the proxy's constructor (replaces the Day 15 constructor).
    function initialize(address stakingToken_, address rewardsToken_, address owner_) external initializer {
        if (stakingToken_ == address(0) || rewardsToken_ == address(0)) revert ZeroAddress();
        if (stakingToken_ == rewardsToken_) revert SameToken();
        __Ownable_init(owner_);
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();
        stakingToken = IERC20(stakingToken_);
        rewardsToken = IERC20(rewardsToken_);
    }

    /// @notice Which logic version the proxy is running.
    function version() external pure virtual returns (string memory) {
        return "1.0.0";
    }

    // ───────────────────────────── views ─────────────────────────────

    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function rewardPerToken() public view returns (uint256) {
        // slither-disable-next-line incorrect-equality
        if (totalStaked == 0) return rewardPerTokenStored;
        return rewardPerTokenStored + ((lastTimeRewardApplicable() - lastUpdateTime) * rewardRateScaled) / totalStaked;
    }

    function earned(address account) public view returns (uint256) {
        return rewards[account]
            + (balanceOf[account] * (rewardPerToken() - userRewardPerTokenPaid[account])) / PRECISION;
    }

    // ─────────────────────────── staker actions ───────────────────────────

    /// @notice Lock `amount` HIM. `virtual` so V2 can add a pause for NEW stakes.
    function stake(uint256 amount) public virtual nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _updateReward(msg.sender);
        uint256 received = _pull(stakingToken, amount);
        // slither-disable-next-line incorrect-equality
        if (received == 0) revert ZeroAmount();
        totalStaked += received;
        balanceOf[msg.sender] += received;
        emit Staked(msg.sender, received);
    }

    /// @notice Take back staked HIM. Always possible, in every version.
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = balanceOf[msg.sender];
        if (amount > bal) revert InsufficientBalance(amount, bal);
        _updateReward(msg.sender);
        balanceOf[msg.sender] = bal - amount;
        totalStaked -= amount;
        stakingToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function getReward() external nonReentrant {
        _updateReward(msg.sender);
        uint256 reward = rewards[msg.sender];
        if (reward > 0) {
            rewards[msg.sender] = 0;
            rewardsToken.safeTransfer(msg.sender, reward);
            emit RewardPaid(msg.sender, reward);
        }
    }

    // ─────────────────────────── owner actions ───────────────────────────

    function notifyRewardAmount(uint256 reward, uint256 duration) external onlyOwner nonReentrant {
        if (reward == 0) revert ZeroAmount();
        if (duration < MIN_DURATION || duration > MAX_DURATION) revert BadDuration(duration);
        _updateReward(address(0));
        uint256 received = _pull(rewardsToken, reward);
        // slither-disable-next-line incorrect-equality
        if (received == 0) revert ZeroAmount();
        uint256 totalScaled = received * PRECISION + unallocatedScaled;
        unallocatedScaled = 0;
        if (block.timestamp < periodFinish) {
            // slither-disable-next-line divide-before-multiply
            totalScaled += (periodFinish - block.timestamp) * rewardRateScaled;
        }
        rewardRateScaled = totalScaled / duration;
        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + duration;
        emit RewardAdded(received, duration, rewardRateScaled, periodFinish);
    }

    // ───────────────────────────── internals ─────────────────────────────

    /// @dev Only the owner may move the proxy to a new logic contract (F-01).
    ///      OpenZeppelin's UUPSUpgradeable also refuses a new logic contract that is not UUPS
    ///      itself (it checks `proxiableUUID`), so an upgrade cannot brick the proxy (F-05).
    // solhint-disable-next-line no-empty-blocks
    function _authorizeUpgrade(address) internal virtual override onlyOwner {}

    function _updateReward(address account) internal {
        uint256 applicable = lastTimeRewardApplicable();
        uint256 elapsed = applicable - lastUpdateTime;
        if (elapsed > 0) {
            if (totalStaked == 0) {
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

    function _pull(IERC20 token, uint256 amount) internal returns (uint256) {
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        return token.balanceOf(address(this)) - before;
    }
}
