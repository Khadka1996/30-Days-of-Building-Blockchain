// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

/// @title HimalVotesToken — HIM with balance history (ERC20Votes), like Day 14
/// @notice Every holder who delegates (usually to themselves) gets a checkpoint each time their balance
///         changes, so a contract can ask "how much HIM did Ram hold at block N?" with `getPastVotes`.
///         A flash loan cannot change the past, which is exactly what `SafeBonus` relies on.
contract HimalVotesToken is ERC20, ERC20Permit, ERC20Votes {
    constructor(uint256 supply, address holder) ERC20("Himal Token", "HIM") ERC20Permit("Himal Token") {
        _mint(holder, supply);
    }

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) {
        super._update(from, to, value);
    }

    function nonces(address owner) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }
}
