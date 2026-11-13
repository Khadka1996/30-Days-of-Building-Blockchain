// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title Community Fund board
/// @notice A tiny example of something the DAO controls: the list of approved
///         community projects. Only the owner (the DAO timelock) can add one,
///         so the only way in is a proposal that passes a vote and waits 2 days.
contract CommunityFund is Ownable {
    struct Project {
        string name;
        address recipient;
        uint256 amount;
    }

    Project[] public projects;

    event ProjectApproved(uint256 indexed id, string name, address indexed recipient, uint256 amount);

    constructor(address dao) Ownable(dao) {}

    function approveProject(string calldata name, address recipient, uint256 amount) external onlyOwner {
        projects.push(Project(name, recipient, amount));
        emit ProjectApproved(projects.length - 1, name, recipient, amount);
    }

    function projectCount() external view returns (uint256) {
        return projects.length;
    }
}
