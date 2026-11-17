// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC3156FlashBorrower} from "@openzeppelin/contracts/interfaces/IERC3156FlashBorrower.sol";

/// @dev TEST ONLY — ⚠️ the classic borrower bug. It checks the lender but NOT the initiator, and it
///      keeps savings in the contract. Anyone can call `lender.flashLoan(thisBot, …)` again and again,
///      and every loan's fee is paid out of the bot's own savings.
contract NaiveBorrower is IERC3156FlashBorrower {
    using SafeERC20 for IERC20;

    address public lender;

    constructor(address lender_) {
        lender = lender_;
    }

    function onFlashLoan(address, address token, uint256 amount, uint256 fee, bytes calldata)
        external
        returns (bytes32)
    {
        require(msg.sender == lender, "untrusted lender");
        // (missing: require(initiator == address(this)))
        IERC20(token).forceApprove(msg.sender, amount + fee);
        return keccak256("ERC3156FlashBorrower.onFlashLoan");
    }
}
