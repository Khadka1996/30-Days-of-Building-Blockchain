// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Governor} from "@openzeppelin/contracts/governance/Governor.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {HimalDAO} from "../HimalDAO.sol";

/// @notice TEST ONLY. HimalDAO with OpenZeppelin's default rule, where the
///         "#proposer=" tag is optional. Used to show the copy-and-cancel attack
///         that the required tag stops (QA.md F-06).
contract OptionalTagDAO is HimalDAO {
    constructor(IVotes token, TimelockController timelock) HimalDAO(token, timelock, 7200, 50400, 10_000 ether, 4) {}

    function _isValidDescriptionForProposer(address proposer, string memory description)
        internal
        view
        override
        returns (bool)
    {
        return Governor._isValidDescriptionForProposer(proposer, description);
    }
}
