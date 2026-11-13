// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

interface ILender {
    function flashLoan(address borrower, uint256 amount) external;
}

interface INaiveDAO {
    function propose(address payable recipient, uint256 amount) external returns (uint256);
    function vote(uint256 id) external;
    function execute(uint256 id) external;
}

/// @notice TEST ONLY. An attacker that borrows a huge amount of HVT for one
///         transaction and tries to use it as votes.
contract FlashVoter {
    IERC20 public immutable TOKEN;
    ILender public immutable LENDER;
    address public immutable OWNER;

    // what to do inside the loan
    uint8 private mode; // 1 = attack naive DAO, 2 = vote on Governor, 3 = propose on Governor
    address private target;
    uint256 private proposalId;

    // results the tests read
    uint256 public weightUsed;
    bool public proposeSucceeded;
    bytes public proposeError;

    constructor(IERC20 token_, ILender lender_) {
        TOKEN = token_;
        LENDER = lender_;
        OWNER = msg.sender;
    }

    receive() external payable {}

    function attackNaive(address dao, uint256 amount) external {
        mode = 1;
        target = dao;
        LENDER.flashLoan(address(this), amount);
        (bool ok,) = OWNER.call{value: address(this).balance}("");
        require(ok, "payout");
    }

    function attackVote(address governor, uint256 id, uint256 amount) external {
        mode = 2;
        target = governor;
        proposalId = id;
        LENDER.flashLoan(address(this), amount);
    }

    function attackPropose(address governor, uint256 amount) external {
        mode = 3;
        target = governor;
        LENDER.flashLoan(address(this), amount);
    }

    function onFlashLoan(uint256 amount) external {
        require(msg.sender == address(LENDER), "lender only");
        if (mode == 1) {
            INaiveDAO dao = INaiveDAO(target);
            uint256 id = dao.propose(payable(address(this)), target.balance);
            dao.vote(id);
            dao.execute(id);
        } else {
            IVotes(address(TOKEN)).delegate(address(this)); // turn tokens into votes
            if (mode == 2) {
                weightUsed = IGovernor(target).castVote(proposalId, 1);
            } else {
                address[] memory t = new address[](1);
                uint256[] memory v = new uint256[](1);
                bytes[] memory c = new bytes[](1);
                t[0] = address(this);
                string memory d = string.concat("flash proposal#proposer=", Strings.toHexString(address(this)));
                try IGovernor(target).propose(t, v, c, d) {
                    proposeSucceeded = true;
                } catch (bytes memory err) {
                    proposeError = err;
                }
            }
        }
        require(TOKEN.transfer(address(LENDER), amount), "repay");
    }
}
