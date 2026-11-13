// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

/// @title Himal Vote Token (HVT)
/// @notice The DAO's voting token. 1 HVT = 1 vote, but only once you delegate
///         (to yourself or to someone you trust).
/// @dev ERC20Votes keeps a history ("checkpoints") of every account's voting
///      power. The DAO reads that history at a block in the PAST (the proposal
///      snapshot), so tokens borrowed or bought after a proposal is created
///      carry no weight on it. That is the core defence against flash-loan voting.
///      The supply is fixed: there is no mint function, so nobody can print votes.
contract HimalVoteToken is ERC20, ERC20Permit, ERC20Votes {
    uint256 public constant TOTAL_SUPPLY = 1_000_000 ether;

    constructor(address treasury) ERC20("Himal Vote Token", "HVT") ERC20Permit("Himal Vote Token") {
        _mint(treasury, TOTAL_SUPPLY);
    }

    // ----- required overrides (ERC20 + ERC20Votes + ERC20Permit) -----

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) {
        super._update(from, to, value);
    }

    function nonces(address owner) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }
}
