// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IClaim {
    function claim(uint256 index, uint256 amount, bytes32[] calldata proof) external;
}

/// @notice TEST ONLY. A hostile token that calls back into the airdrop during a transfer.
contract ReentrantToken is ERC20 {
    IClaim public target;
    uint256 public index;
    uint256 public amount;
    bytes32[] public proof;
    bool public attacked;
    bool public attackSucceeded;

    constructor() ERC20("Hostile", "BAD") {
        _mint(msg.sender, 1_000_000 ether);
    }

    function arm(IClaim target_, uint256 index_, uint256 amount_, bytes32[] calldata proof_) external {
        target = target_;
        index = index_;
        amount = amount_;
        proof = proof_;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (address(target) != address(0) && !attacked && from == address(target)) {
            attacked = true;
            try this.reenter() {
                attackSucceeded = true;
            } catch {
                attackSucceeded = false;
            }
        }
    }

    function reenter() external {
        target.claim(index, amount, proof);
    }

    function claimFor(uint256 index_, uint256 amount_, bytes32[] calldata proof_) external {
        target.claim(index_, amount_, proof_);
    }
}
