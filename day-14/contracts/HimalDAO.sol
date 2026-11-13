// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Governor} from "@openzeppelin/contracts/governance/Governor.sol";
import {GovernorSettings} from "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import {GovernorCountingSimple} from "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import {GovernorVotes} from "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import {GovernorVotesQuorumFraction} from
    "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import {GovernorTimelockControl} from "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title Himal DAO
/// @notice Token holders propose and vote; passed proposals are queued in the
///         timelock and run after a delay.
///
///  Life of a proposal:
///   propose ──(1 day voting delay)──> vote for 1 week ──> passed? ──> queue
///           ──(2 day timelock)──> execute (by anyone)
///
///  Rules (all measured at the proposal's snapshot block, in the past):
///   - Proposing needs 1% of the supply (10,000 HVT) of voting power -> stops spam.
///   - A proposal passes if For > Against AND For + Abstain reach 4% of supply (quorum).
///   - Voting power comes from ERC20Votes checkpoints, so flash-loaned or
///     freshly bought tokens do not count.
///   - Every description must end with "#proposer=<your address in lowercase>",
///     so nobody can copy a waiting proposal, submit it first and cancel it.
contract HimalDAO is
    Governor,
    GovernorSettings,
    GovernorCountingSimple,
    GovernorVotes,
    GovernorVotesQuorumFraction,
    GovernorTimelockControl
{
    /// @param token      the HVT token (ERC20Votes)
    /// @param timelock   the treasury timelock that executes passed proposals
    /// @param delayBlocks  blocks between propose and the start of voting (7200 ≈ 1 day)
    /// @param periodBlocks blocks voting stays open (50400 ≈ 1 week)
    /// @param threshold  voting power needed to create a proposal (10,000 HVT)
    /// @param quorumPercent percentage of total supply that must vote For or Abstain (4)
    constructor(
        IVotes token,
        TimelockController timelock,
        uint48 delayBlocks,
        uint32 periodBlocks,
        uint256 threshold,
        uint256 quorumPercent
    )
        Governor("Himal DAO")
        GovernorSettings(delayBlocks, periodBlocks, threshold)
        GovernorVotes(token)
        GovernorVotesQuorumFraction(quorumPercent)
        GovernorTimelockControl(timelock)
    {}

    /// @dev Stricter than OpenZeppelin's default: the "#proposer=0x…" tag is
    ///      REQUIRED, not optional. Without it, anyone who sees a proposal
    ///      waiting to be mined can send the same one first, become its
    ///      proposer and cancel it; the identical proposal can then never be
    ///      created again (QA.md F-06). The address must be lowercase hex.
    function _isValidDescriptionForProposer(address proposer, string memory description)
        internal
        view
        virtual
        override
        returns (bool)
    {
        bytes memory text = bytes(description);
        bytes memory tag = bytes(string.concat("#proposer=", Strings.toHexString(proposer)));
        if (text.length < tag.length) return false;
        uint256 offset = text.length - tag.length;
        for (uint256 i = 0; i < tag.length; ++i) {
            if (text[offset + i] != tag[i]) return false;
        }
        return true;
    }

    // ----- required overrides (Solidity needs us to pick which parent wins) -----

    function votingDelay() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.votingDelay();
    }

    function votingPeriod() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.votingPeriod();
    }

    function quorum(uint256 blockNumber)
        public
        view
        override(Governor, GovernorVotesQuorumFraction)
        returns (uint256)
    {
        return super.quorum(blockNumber);
    }

    function proposalThreshold() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.proposalThreshold();
    }

    function state(uint256 proposalId)
        public
        view
        override(Governor, GovernorTimelockControl)
        returns (ProposalState)
    {
        return super.state(proposalId);
    }

    function proposalNeedsQueuing(uint256 proposalId)
        public
        view
        override(Governor, GovernorTimelockControl)
        returns (bool)
    {
        return super.proposalNeedsQueuing(proposalId);
    }

    function _queueOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint48) {
        return super._queueOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _executeOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) {
        super._executeOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _cancel(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint256) {
        return super._cancel(targets, values, calldatas, descriptionHash);
    }

    function _executor() internal view override(Governor, GovernorTimelockControl) returns (address) {
        return super._executor();
    }
}
