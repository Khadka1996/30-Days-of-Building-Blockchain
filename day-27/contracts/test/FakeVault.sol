// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Deliberately hostile contract used only by the tests.

/// @notice A look-alike that emits the vault's events with scary numbers.
///         The monitor must only trust logs from the real vault address.
contract FakeVault {
    event Withdrawn(address indexed user, uint256 amount, uint256 totalAfter);
    event ChangeQueued(uint8 indexed kind, uint256 value, uint256 eta, address indexed by);

    function fake(uint256 amount) external {
        emit Withdrawn(msg.sender, amount, 0);
        emit ChangeQueued(0, amount, block.timestamp, msg.sender);
    }
}
