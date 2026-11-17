// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice The one function both loyalty bonuses share.
interface IBonus {
    function claim() external returns (uint256 amount);
}
