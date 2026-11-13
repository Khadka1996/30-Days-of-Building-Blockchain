// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IFlashBorrower {
    function onFlashLoan(uint256 amount) external;
}

/// @notice TEST ONLY. A free flash-loan pool: lend any amount of its tokens for
///         the length of one call, and require every token back by the end.
contract FlashLender {
    IERC20 public immutable TOKEN;

    error NotRepaid();

    constructor(IERC20 token_) {
        TOKEN = token_;
    }

    function flashLoan(IFlashBorrower borrower, uint256 amount) external {
        uint256 before = TOKEN.balanceOf(address(this));
        require(TOKEN.transfer(address(borrower), amount), "transfer");
        borrower.onFlashLoan(amount);
        if (TOKEN.balanceOf(address(this)) < before) revert NotRepaid();
    }
}
