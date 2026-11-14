// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev TEST ONLY — DO NOT USE. Pays each reward deposit out at once to whoever is
///      staked at that moment. Someone who sees the deposit coming can stake just before
///      it, claim a big share, and leave straight after ("just-in-time staking").
contract NaiveLumpStaking {
    // solhint-disable-next-line immutable-vars-naming
    IERC20 public immutable stakingToken;
    // solhint-disable-next-line immutable-vars-naming
    IERC20 public immutable rewardsToken;
    uint256 public totalStaked;
    uint256 public rewardPerToken; // × 1e18
    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public paid;
    mapping(address => uint256) public owed;

    constructor(address s, address r) {
        stakingToken = IERC20(s);
        rewardsToken = IERC20(r);
    }

    function _settle(address a) internal {
        owed[a] += (balanceOf[a] * (rewardPerToken - paid[a])) / 1e18;
        paid[a] = rewardPerToken;
    }

    function stake(uint256 amount) external {
        _settle(msg.sender);
        stakingToken.transferFrom(msg.sender, address(this), amount);
        balanceOf[msg.sender] += amount;
        totalStaked += amount;
    }

    function withdraw(uint256 amount) external {
        _settle(msg.sender);
        balanceOf[msg.sender] -= amount;
        totalStaked -= amount;
        stakingToken.transfer(msg.sender, amount);
    }

    function getReward() external {
        _settle(msg.sender);
        uint256 r = owed[msg.sender];
        owed[msg.sender] = 0;
        rewardsToken.transfer(msg.sender, r);
    }

    /// The whole deposit is shared out instantly — the flaw.
    function deposit(uint256 reward) external {
        rewardsToken.transferFrom(msg.sender, address(this), reward);
        rewardPerToken += (reward * 1e18) / totalStaked;
    }
}
