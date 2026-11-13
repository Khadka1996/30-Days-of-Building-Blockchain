// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title Himal Timelock (the DAO treasury)
/// @notice Holds the DAO's money and is the only address allowed to act for the
///         DAO. Every passed proposal must wait here for `minDelay` (2 days in
///         the deploy script) before anyone can execute it, so members who
///         disagree have time to leave.
/// @dev Plain OpenZeppelin TimelockController. The deploy script gives the
///      Governor the proposer and canceller roles, opens the executor role to
///      everyone (address(0)) and then RENOUNCES the deployer's admin role, so
///      after deployment only the DAO itself can change these roles.
contract HimalTimelock is TimelockController {
    constructor(uint256 minDelay, address[] memory proposers, address[] memory executors, address admin)
        TimelockController(minDelay, proposers, executors, admin)
    {}
}
