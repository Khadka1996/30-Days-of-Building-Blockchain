// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC3156FlashLender} from "@openzeppelin/contracts/interfaces/IERC3156FlashLender.sol";
import {IERC3156FlashBorrower} from "@openzeppelin/contracts/interfaces/IERC3156FlashBorrower.sol";

/// @dev TEST ONLY. A borrower that behaves well or badly depending on `mode`, to attack the lender.
contract TestBorrower is IERC3156FlashBorrower {
    using SafeERC20 for IERC20;

    enum Mode {
        Repay, // approve amount + fee, return the magic value
        NoApprove, // keep the money: never approve
        WrongReturn, // approve, but return a wrong value
        ApproveLess, // approve only the amount, not the fee
        Reenter, // borrow again from inside the callback
        SendBack // push amount + fee back with transfer() instead of approving
    }

    IERC3156FlashLender public lender;
    Mode public mode;
    uint256 public calls;

    constructor(IERC3156FlashLender lender_) {
        lender = lender_;
    }

    function setMode(Mode m) external {
        mode = m;
    }

    function borrow(address token, uint256 amount) external {
        lender.flashLoan(this, token, amount, "");
    }

    function onFlashLoan(address, address token, uint256 amount, uint256 fee, bytes calldata)
        external
        returns (bytes32)
    {
        calls++;
        Mode m = mode;
        if (m == Mode.Reenter) lender.flashLoan(this, token, amount, "");
        if (m == Mode.Repay || m == Mode.WrongReturn || m == Mode.Reenter) {
            IERC20(token).forceApprove(msg.sender, amount + fee);
        }
        if (m == Mode.ApproveLess) IERC20(token).forceApprove(msg.sender, amount);
        if (m == Mode.SendBack) IERC20(token).safeTransfer(msg.sender, amount + fee);
        if (m == Mode.WrongReturn) return bytes32(0);
        return keccak256("ERC3156FlashBorrower.onFlashLoan");
    }
}
