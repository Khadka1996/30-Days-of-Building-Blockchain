// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IStaking {
    function stake(uint256 amount) external;
    function withdraw(uint256 amount) external;
    function getReward() external;
}

/// @dev TEST ONLY. Stakes, then tries to withdraw a second time from inside the token hook.
contract ReentrantStaker {
    // solhint-disable-next-line immutable-vars-naming
    IStaking public immutable staking;
    // solhint-disable-next-line immutable-vars-naming
    IERC20 public immutable token;
    bool private attacking;

    constructor(address staking_, address token_) {
        staking = IStaking(staking_);
        token = IERC20(token_);
    }

    function stake(uint256 amount) external {
        token.approve(address(staking), amount);
        staking.stake(amount);
    }

    function attack(uint256 amount) external {
        attacking = true;
        staking.withdraw(amount);
        attacking = false;
    }

    function onTokenReceived(uint256 amount) external {
        if (attacking && msg.sender == address(token)) {
            attacking = false;
            staking.withdraw(amount); // second withdrawal of the same stake
        }
    }
}
