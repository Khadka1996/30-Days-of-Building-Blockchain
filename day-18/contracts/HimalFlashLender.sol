// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC3156FlashLender} from "@openzeppelin/contracts/interfaces/IERC3156FlashLender.sol";
import {IERC3156FlashBorrower} from "@openzeppelin/contracts/interfaces/IERC3156FlashBorrower.sol";

/// @title HimalFlashLender — an ERC-3156 flash lender: borrow anything it holds, repay in the same transaction
/// @notice A flash loan needs no collateral because it cannot go unpaid. Inside ONE transaction the lender:
///         1. sends `amount` to the borrower contract,
///         2. calls `receiver.onFlashLoan(...)`, where the borrower uses the money,
///         3. pulls back `amount + fee` with `transferFrom`.
///         If step 3 fails for any reason, the whole transaction reverts, as if the loan never happened.
/// @dev Safety rules this contract follows:
///      - the callback must return the ERC-3156 magic value (so random contracts are not "borrowers"),
///      - repayment is PULLED with `transferFrom`, never trusted, and the balance is checked afterwards,
///      - every entry point is `nonReentrant`, so the money cannot be lent twice or withdrawn mid-loan,
///      - the fee rounds UP, so many tiny loans cannot be free.
contract HimalFlashLender is IERC3156FlashLender, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice keccak256("ERC3156FlashBorrower.onFlashLoan"), the value a borrower must return.
    bytes32 public constant CALLBACK_SUCCESS = keccak256("ERC3156FlashBorrower.onFlashLoan");
    /// @notice Fee in basis points: 9 = 0.09% (the same as Aave V2).
    uint256 public constant FEE_BPS = 9;
    uint256 private constant BPS = 10_000;

    /// @notice Tokens this lender is willing to lend.
    mapping(address token => bool) public supported;
    /// @notice Fees collected per token, for reporting.
    mapping(address token => uint256) public feesEarned;

    event Supported(address indexed token, bool allowed);
    event FlashLoan(address indexed initiator, address indexed receiver, address indexed token, uint256 amount, uint256 fee);
    event Withdrawn(address indexed token, uint256 amount, address indexed to);

    error UnsupportedToken(address token);
    error ZeroAmount();
    error ZeroAddress();
    error AmountTooLarge(uint256 amount, uint256 max);
    error CallbackFailed();
    error NotRepaid(uint256 balance, uint256 required);

    constructor(address owner_) Ownable(owner_) {}

    // ------------------------------------------------------------------ admin

    function setSupported(address token, bool allowed) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        supported[token] = allowed;
        emit Supported(token, allowed);
    }

    /// @notice Owner takes liquidity or fees out. `nonReentrant`, so it cannot run in the middle of a loan.
    function withdraw(address token, uint256 amount, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(token, amount, to);
    }

    // ------------------------------------------------------------------ ERC-3156

    /// @inheritdoc IERC3156FlashLender
    function maxFlashLoan(address token) public view returns (uint256) {
        return supported[token] ? IERC20(token).balanceOf(address(this)) : 0;
    }

    /// @inheritdoc IERC3156FlashLender
    /// @dev Rounds up: a 1-wei loan pays a 1-wei fee.
    function flashFee(address token, uint256 amount) public view returns (uint256) {
        if (!supported[token]) revert UnsupportedToken(token);
        return (amount * FEE_BPS + BPS - 1) / BPS;
    }

    /// @inheritdoc IERC3156FlashLender
    function flashLoan(IERC3156FlashBorrower receiver, address token, uint256 amount, bytes calldata data)
        external
        nonReentrant
        returns (bool)
    {
        if (amount == 0) revert ZeroAmount();
        uint256 max = maxFlashLoan(token);
        if (amount > max) revert AmountTooLarge(amount, max);

        uint256 fee = flashFee(token, amount);
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        // Written before any external call (checks-effects-interactions). If the loan is not repaid,
        // the whole transaction reverts, and this line with it.
        feesEarned[token] += fee;
        emit FlashLoan(msg.sender, address(receiver), token, amount, fee);

        // 1. lend
        IERC20(token).safeTransfer(address(receiver), amount);
        // 2. let the borrower use it; it must answer with the magic value
        if (receiver.onFlashLoan(msg.sender, token, amount, fee, data) != CALLBACK_SUCCESS) revert CallbackFailed();
        // 3. take the money back. Pulling from `receiver` is safe: it just received `amount`, approved
        //    `amount + fee` itself and answered the callback. A receiver must still check WHO started the
        //    loan (`initiator`), or strangers can make it pay fees (see FlashArbitrage).
        // slither-disable-next-line arbitrary-send-erc20
        IERC20(token).safeTransferFrom(address(receiver), address(this), amount + fee);

        // 4. belt and braces: the balance must really have grown by the fee (catches fee-on-transfer tokens).
        //    Reading the balance before and after the callback is the point here, and `nonReentrant`
        //    stops anything else from moving it in between.
        // slither-disable-next-line reentrancy-balance
        uint256 balanceAfter = IERC20(token).balanceOf(address(this));
        // slither-disable-next-line reentrancy-balance
        if (balanceAfter < balanceBefore + fee) revert NotRepaid(balanceAfter, balanceBefore + fee);
        return true;
    }
}
