// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice TEST ONLY — the WRONG way to build a DAO, kept to show the attack.
///         Votes are weighted by the voter's balance RIGHT NOW, and a proposal
///         runs the moment it has more than half of the supply. A flash loan
///         turns "rich for one transaction" into "owns the treasury".
contract NaiveDAO {
    IERC20 public immutable TOKEN;

    struct Proposal {
        address payable recipient;
        uint256 amount;
        uint256 votes;
        bool executed;
    }

    Proposal[] public proposals;
    mapping(uint256 => mapping(address => bool)) public voted;

    constructor(IERC20 token_) {
        TOKEN = token_;
    }

    receive() external payable {}

    function propose(address payable recipient, uint256 amount) external returns (uint256 id) {
        proposals.push(Proposal(recipient, amount, 0, false));
        return proposals.length - 1;
    }

    function vote(uint256 id) external {
        require(!voted[id][msg.sender], "voted");
        voted[id][msg.sender] = true;
        proposals[id].votes += TOKEN.balanceOf(msg.sender); // BUG: live balance
    }

    function execute(uint256 id) external {
        Proposal storage p = proposals[id];
        require(!p.executed, "done");
        require(p.votes * 2 > TOKEN.totalSupply(), "not passed"); // BUG: no delay
        p.executed = true;
        (bool ok,) = p.recipient.call{value: p.amount}("");
        require(ok, "send");
    }
}
