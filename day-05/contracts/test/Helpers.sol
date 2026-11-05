// SPDX-License-Identifier: MIT
// solhint-disable one-contract-per-file, immutable-vars-naming, no-complex-fallback, avoid-low-level-calls, no-empty-blocks
pragma solidity 0.8.24;

// Test-only helper contracts. Not part of the escrow contract.

interface IEscrow {
    function openDeal(address seller, address arbiter, uint256 duration) external payable returns (uint256);
    function confirmDelivery(uint256 id) external;
    function refundBuyer(uint256 id) external;
    function dispute(uint256 id) external;
    function claimAfterDeadline(uint256 id) external;
    function withdraw() external;
}

/// @notice A buyer or seller contract. It can act on a deal, and when it receives ETH
///         it either refuses it (refuse = true) or tries to call withdraw() again.
contract PartyContract {
    IEscrow public immutable escrow;
    bool public refuse;
    bool public reenter;
    bool public reentryFailed;
    uint256 public received;

    constructor(IEscrow escrow_) {
        escrow = escrow_;
    }

    function setMode(bool refuse_, bool reenter_) external {
        refuse = refuse_;
        reenter = reenter_;
    }

    function openDeal(address seller, address arbiter, uint256 duration) external payable returns (uint256) {
        return escrow.openDeal{value: msg.value}(seller, arbiter, duration);
    }

    function confirmDelivery(uint256 id) external { escrow.confirmDelivery(id); }
    function refundBuyer(uint256 id) external { escrow.refundBuyer(id); }
    function dispute(uint256 id) external { escrow.dispute(id); }
    function claimAfterDeadline(uint256 id) external { escrow.claimAfterDeadline(id); }
    function withdraw() external { escrow.withdraw(); }

    receive() external payable {
        if (refuse) revert("I refuse ETH");
        received += msg.value;
        if (reenter) {
            reenter = false;
            try escrow.withdraw() {} catch { reentryFailed = true; }
        }
    }
}

/// @notice Forces ETH into a contract with selfdestruct (it skips receive()).
contract ForceSend {
    constructor(address payable target) payable {
        selfdestruct(target);
    }
}
