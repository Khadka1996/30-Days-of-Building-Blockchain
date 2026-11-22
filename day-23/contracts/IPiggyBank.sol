// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice The two money-moving functions of PiggyBank (used by other contracts).
interface IPiggyBank {
    function deposit(uint64 unlockAt) external payable;
    function withdraw() external;
}
