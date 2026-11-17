// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IBonus} from "./IBonus.sol";

/// @title NaiveBonus — ⚠️ VULNERABLE ON PURPOSE. Do not copy.
/// @notice A "loyalty bonus": every HIM holder may claim once, 1 HUSD for every 10 HIM they hold.
/// @dev The bug: it reads `him.balanceOf(msg.sender)` RIGHT NOW. Holding tokens for one line of code is
///      free with a flash loan: borrow 1,000,000 HIM, claim, repay. See `BonusAttacker` and `SafeBonus`.
contract NaiveBonus is IBonus {
    using SafeERC20 for IERC20;

    // solhint-disable immutable-vars-naming
    IERC20 public immutable him;
    IERC20 public immutable husd;
    // solhint-enable immutable-vars-naming
    /// @notice HUSD paid per 1 HIM, scaled by 1e18 (0.1e18 = 1 HUSD per 10 HIM).
    uint256 public constant RATE = 0.1e18;

    mapping(address => bool) public claimed;

    event Claimed(address indexed who, uint256 amount);

    error AlreadyClaimed();
    error NothingToClaim();

    constructor(IERC20 him_, IERC20 husd_) {
        him = him_;
        husd = husd_;
    }

    function claim() external returns (uint256 amount) {
        if (claimed[msg.sender]) revert AlreadyClaimed();
        amount = (him.balanceOf(msg.sender) * RATE) / 1e18; // ⚠️ the balance at this very moment
        uint256 left = husd.balanceOf(address(this));
        if (amount > left) amount = left;
        // slither-disable-next-line incorrect-equality
        if (amount == 0) revert NothingToClaim();
        claimed[msg.sender] = true;
        emit Claimed(msg.sender, amount);
        husd.safeTransfer(msg.sender, amount);
    }
}
