// SPDX-License-Identifier: MIT
// solhint-disable one-contract-per-file
pragma solidity 0.8.24;

// Test-only helper contracts. Not part of the wallet.

interface IMultiSig {
    function submit(address to, uint256 value, bytes calldata data) external returns (uint256);
    function approve(uint256 txId) external;
    function execute(uint256 txId) external;
}

/// @notice A simple contract the wallet can call, to show calls with data work.
contract Counter {
    uint256 public count;
    address public lastCaller;

    function increment(uint256 by) external payable {
        count += by;
        lastCaller = msg.sender;
    }

    function fail() external pure {
        revert("Counter: nope");
    }
}

/// @notice An owner contract that tries to execute again when it receives ETH.
contract ReentrantOwner {
    IMultiSig public wallet;
    uint256 public replayTxId;
    bool public attempted;
    bool public replaySucceeded;

    function setWallet(address wallet_) external {
        wallet = IMultiSig(wallet_);
    }

    function propose(address to, uint256 value) external returns (uint256) {
        return wallet.submit(to, value, "");
    }

    function approveTx(uint256 txId) external {
        wallet.approve(txId);
    }

    function executeTx(uint256 txId, uint256 replayId) external {
        replayTxId = replayId;
        wallet.execute(txId);
    }

    receive() external payable {
        if (!attempted) {
            attempted = true;
            // Try to run a proposal again (or a second one) from inside the payment.
            try wallet.execute(replayTxId) {
                replaySucceeded = true;
            } catch {
                replaySucceeded = false;
            }
        }
    }
}
