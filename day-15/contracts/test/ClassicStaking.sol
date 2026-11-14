// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev TEST ONLY — DO NOT USE. The classic streaming formula with two rounding flaws:
///      1. rewardRate = reward / duration is stored UNscaled, so the remainder is lost
///         and a small reward over a long period rounds to 0 per second;
///      2. seconds when nobody is staked still "pay out" — to nobody — and those rewards
///         are stuck in the contract forever.
contract ClassicStaking {
    // solhint-disable-next-line immutable-vars-naming
    IERC20 public immutable stakingToken;
    // solhint-disable-next-line immutable-vars-naming
    IERC20 public immutable rewardsToken;
    uint256 public periodFinish;
    uint256 public rewardRate;
    uint256 public lastUpdateTime;
    uint256 public rewardPerTokenStored;
    uint256 public totalStaked;
    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public paid;
    mapping(address => uint256) public rewards;

    constructor(address s, address r) {
        stakingToken = IERC20(s);
        rewardsToken = IERC20(r);
    }

    function lastTime() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function rewardPerToken() public view returns (uint256) {
        if (totalStaked == 0) return rewardPerTokenStored;
        return rewardPerTokenStored + ((lastTime() - lastUpdateTime) * rewardRate * 1e18) / totalStaked;
    }

    function earned(address a) public view returns (uint256) {
        return rewards[a] + (balanceOf[a] * (rewardPerToken() - paid[a])) / 1e18;
    }

    function _update(address a) internal {
        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = lastTime(); // advances even when totalStaked == 0 → rewards lost
        rewards[a] = earned(a);
        paid[a] = rewardPerTokenStored;
    }

    function stake(uint256 amount) external {
        _update(msg.sender);
        stakingToken.transferFrom(msg.sender, address(this), amount);
        balanceOf[msg.sender] += amount;
        totalStaked += amount;
    }

    function getReward() external {
        _update(msg.sender);
        uint256 r = rewards[msg.sender];
        rewards[msg.sender] = 0;
        rewardsToken.transfer(msg.sender, r);
    }

    function notifyRewardAmount(uint256 reward, uint256 duration) external {
        _update(address(0));
        rewardsToken.transferFrom(msg.sender, address(this), reward);
        rewardRate = reward / duration; // remainder lost
        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + duration;
    }
}
