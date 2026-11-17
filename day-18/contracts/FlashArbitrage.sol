// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC3156FlashLender} from "@openzeppelin/contracts/interfaces/IERC3156FlashLender.sol";
import {IERC3156FlashBorrower} from "@openzeppelin/contracts/interfaces/IERC3156FlashBorrower.sol";
import {HimalRouter} from "./HimalRouter.sol";

/// @title FlashArbitrage — borrow, buy cheap on one exchange, sell dear on another, repay, keep the difference
/// @notice Example: HIM costs 10 HUSD on Himal Swap and 12 HUSD on Everest Swap. With a flash loan of HUSD
///         the bot buys HIM on Himal Swap, sells it on Everest Swap, repays the loan plus 0.09%, and sends
///         what is left to its owner. It needs no money of its own; if the trade does not pay, it all reverts.
/// @dev Three borrower-side rules (the bugs most flash-loan receivers get wrong):
///      1. `onFlashLoan` only accepts calls from the trusted lender (`msg.sender == lender`),
///      2. and only for loans this contract started itself (`initiator == address(this)`),
///      3. and it reverts unless the profit is at least `minProfit`, so a bad trade costs nothing but gas.
contract FlashArbitrage is IERC3156FlashBorrower, Ownable {
    using SafeERC20 for IERC20;

    bytes32 private constant CALLBACK_SUCCESS = keccak256("ERC3156FlashBorrower.onFlashLoan");

    // solhint-disable-next-line immutable-vars-naming
    IERC3156FlashLender public immutable lender;

    struct Trade {
        HimalRouter buyRouter; // where the middle token is cheap
        HimalRouter sellRouter; // where it is dear
        address[] buyPath; // e.g. [HUSD, HIM]
        address[] sellPath; // e.g. [HIM, HUSD]
        uint256 minProfit; // revert unless at least this much is left after repaying
        uint256 deadline;
    }

    event Arbitrage(address indexed token, uint256 borrowed, uint256 fee, uint256 profit);

    error UntrustedLender(address caller);
    error UntrustedInitiator(address initiator);
    error BadPath();
    error NotProfitable(uint256 profit, uint256 minProfit);
    error LoanFailed();

    constructor(IERC3156FlashLender lender_, address owner_) Ownable(owner_) {
        lender = lender_;
    }

    /// @notice Start the arbitrage: borrow `amount` of `buyPath[0]` and run `trade` with it.
    /// @return profit What the owner received, after the loan and fee were repaid.
    function run(uint256 amount, Trade calldata trade) external onlyOwner returns (uint256 profit) {
        address token = trade.buyPath[0];
        uint256 len = trade.buyPath.length;
        if (len < 2 || trade.sellPath.length < 2) revert BadPath();
        if (trade.sellPath[0] != trade.buyPath[len - 1] || trade.sellPath[trade.sellPath.length - 1] != token) {
            revert BadPath();
        }

        uint256 before = IERC20(token).balanceOf(address(this));
        if (!lender.flashLoan(this, token, amount, abi.encode(trade))) revert LoanFailed();
        profit = IERC20(token).balanceOf(address(this)) - before;
        IERC20(token).safeTransfer(owner(), profit);
    }

    /// @inheritdoc IERC3156FlashBorrower
    function onFlashLoan(address initiator, address token, uint256 amount, uint256 fee, bytes calldata data)
        external
        returns (bytes32)
    {
        if (msg.sender != address(lender)) revert UntrustedLender(msg.sender);
        if (initiator != address(this)) revert UntrustedInitiator(initiator);

        Trade memory t = abi.decode(data, (Trade));
        address mid = t.buyPath[t.buyPath.length - 1];

        // Buy the middle token where it is cheap…
        IERC20(token).forceApprove(address(t.buyRouter), amount);
        // Return values ignored on purpose: we measure real balances instead of trusting quotes.
        // slither-disable-next-line unused-return
        t.buyRouter.swapExactTokensForTokens(amount, 0, t.buyPath, address(this), t.deadline);

        // …and sell all of it where it is dear. (Per-swap minimums are 0 on purpose: the profit check
        // below is stricter than any per-swap limit, because it covers the whole round trip.)
        uint256 midAmount = IERC20(mid).balanceOf(address(this));
        IERC20(mid).forceApprove(address(t.sellRouter), midAmount);
        // slither-disable-next-line unused-return
        t.sellRouter.swapExactTokensForTokens(midAmount, 0, t.sellPath, address(this), t.deadline);

        uint256 owed = amount + fee;
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 profit = balance > owed ? balance - owed : 0;
        if (balance < owed || profit < t.minProfit) revert NotProfitable(profit, t.minProfit);

        // Let the lender pull exactly what is owed, nothing more.
        IERC20(token).forceApprove(address(lender), owed);
        // slither-disable-next-line reentrancy-events
        emit Arbitrage(token, amount, fee, profit);
        return CALLBACK_SUCCESS;
    }
}
