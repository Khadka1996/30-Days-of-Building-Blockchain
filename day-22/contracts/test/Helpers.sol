// SPDX-License-Identifier: MIT
// solhint-disable one-contract-per-file
pragma solidity 0.8.24;

// Helper contracts used ONLY by the tests to play the attacker or an unusual user.

import {IPiggyBank} from "../IPiggyBank.sol";

/// @notice Tries to call withdraw() again from inside its receive() (reentrancy).
contract ReentrancyAttacker {
    IPiggyBank public immutable BANK;
    uint256 public reentryAttempts;
    bool public reentrySucceeded;

    constructor(IPiggyBank bank_) {
        BANK = bank_;
    }

    function save(uint64 unlockAt) external payable {
        BANK.deposit{value: msg.value}(unlockAt);
    }

    function attack() external {
        BANK.withdraw();
    }

    receive() external payable {
        if (reentryAttempts == 0) {
            reentryAttempts = 1;
            // If the bank still showed a balance here, this would pay out twice.
            try BANK.withdraw() {
                reentrySucceeded = true;
            } catch {
                reentrySucceeded = false;
            }
        }
    }
}

/// @notice A smart-contract wallet whose receive() uses more than 2300 gas
///         (it writes to storage), like many real multisig / smart wallets.
contract SmartWallet {
    IPiggyBank public immutable BANK;
    uint256 public received;

    constructor(IPiggyBank bank_) {
        BANK = bank_;
    }

    function save(uint64 unlockAt) external payable {
        BANK.deposit{value: msg.value}(unlockAt);
    }

    function take() external {
        BANK.withdraw();
    }

    receive() external payable {
        received += msg.value; // storage write: fails with transfer()/send()
    }
}

/// @notice A contract that refuses all ETH (no receive / fallback).
contract RejectingWallet {
    IPiggyBank public immutable BANK;

    constructor(IPiggyBank bank_) {
        BANK = bank_;
    }

    function save(uint64 unlockAt) external payable {
        BANK.deposit{value: msg.value}(unlockAt);
    }

    function take() external {
        BANK.withdraw();
    }
}

/// @notice Force-sends ETH to any address with selfdestruct, bypassing receive().
contract ForceSender {
    constructor(address payable target) payable {
        selfdestruct(target);
    }
}
