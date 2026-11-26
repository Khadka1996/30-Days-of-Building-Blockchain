// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Deliberately hostile contract used only by the tests.

interface IVault {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/// @notice Tries to withdraw again from inside the ETH transfer (re-entrancy).
contract ReentrantMember {
    IVault public immutable vault;
    uint256 public attempts;

    constructor(IVault vault_) {
        vault = vault_;
    }

    function join() external payable {
        vault.deposit{value: msg.value}();
    }

    function attack(uint256 amount) external {
        vault.withdraw(amount);
    }

    receive() external payable {
        if (attempts++ == 0) vault.withdraw(msg.value);
    }
}
