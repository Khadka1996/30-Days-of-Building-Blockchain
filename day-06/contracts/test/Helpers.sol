// SPDX-License-Identifier: MIT
// solhint-disable one-contract-per-file, immutable-vars-naming, no-complex-fallback, avoid-low-level-calls
pragma solidity 0.8.24;

// Test-only helper contracts. Not part of the crowdfunding contract.

interface ICrowdFund {
    function launch(uint256 goal, uint256 duration) external returns (uint256);
    function pledge(uint256 id) external payable;
    function unpledge(uint256 id, uint256 amount) external;
    function claim(uint256 id) external;
    function refund(uint256 id) external;
}

/// @notice A backer (or creator) contract that tries to call back in when it receives ETH.
///         mode 1 = refund again, 2 = claim again, 3 = unpledge again.
contract ReentrantActor {
    ICrowdFund public immutable fund;
    uint256 public id;
    uint8 public mode;
    bool public reentryFailed;
    uint256 public received;

    constructor(ICrowdFund fund_) {
        fund = fund_;
    }

    function launch(uint256 goal, uint256 duration) external {
        id = fund.launch(goal, duration);
    }

    function pledge(uint256 id_) external payable {
        id = id_;
        fund.pledge{value: msg.value}(id_);
    }

    function attack(uint8 mode_) external {
        mode = mode_;
        if (mode_ == 1) fund.refund(id);
        else if (mode_ == 2) fund.claim(id);
        else fund.unpledge(id, 1 ether);
    }

    receive() external payable {
        received += msg.value;
        uint8 m = mode;
        mode = 0; // try only once
        if (m == 0) return;
        bool ok;
        if (m == 1) (ok, ) = address(fund).call(abi.encodeCall(ICrowdFund.refund, (id)));
        else if (m == 2) (ok, ) = address(fund).call(abi.encodeCall(ICrowdFund.claim, (id)));
        else (ok, ) = address(fund).call(abi.encodeCall(ICrowdFund.unpledge, (id, 1 ether)));
        reentryFailed = !ok;
    }
}

/// @notice A backer that can never receive ETH (it reverts on every payment).
contract RejectingBacker {
    function pledge(ICrowdFund fund, uint256 id) external payable {
        fund.pledge{value: msg.value}(id);
    }

    function refund(ICrowdFund fund, uint256 id) external {
        fund.refund(id);
    }

    receive() external payable {
        revert("I refuse ETH");
    }
}

/// @notice Forces ETH into a contract with selfdestruct, skipping its receive().
contract ForceSender {
    constructor(address payable target) payable {
        selfdestruct(target);
    }
}
