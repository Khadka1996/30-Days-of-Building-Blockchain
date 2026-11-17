// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IBonus} from "./IBonus.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";

/// @title SafeBonus — the same loyalty bonus, measured at a block in the PAST
/// @notice Every HIM holder may claim once, 1 HUSD for every 10 HIM they held (and had delegated)
///         at `snapshotBlock`, a block that was already mined when this contract was deployed.
/// @dev A flash loan lives inside one transaction, so it can never show up in a past balance. Even a
///      loan taken in the snapshot block itself is repaid before that block ends, and `getPastVotes`
///      records the balance at the END of a block.
contract SafeBonus is IBonus {
    using SafeERC20 for IERC20;

    // solhint-disable immutable-vars-naming
    IVotes public immutable him;
    IERC20 public immutable husd;
    uint256 public immutable snapshotBlock;
    // solhint-enable immutable-vars-naming
    uint256 public constant RATE = 0.1e18;

    mapping(address => bool) public claimed;

    event Claimed(address indexed who, uint256 amount);

    error AlreadyClaimed();
    error NothingToClaim();
    error SnapshotNotInPast(uint256 snapshotBlock, uint256 currentBlock);

    constructor(IVotes him_, IERC20 husd_, uint256 snapshotBlock_) {
        if (snapshotBlock_ >= block.number) revert SnapshotNotInPast(snapshotBlock_, block.number);
        him = him_;
        husd = husd_;
        snapshotBlock = snapshotBlock_;
    }

    function claim() external returns (uint256 amount) {
        if (claimed[msg.sender]) revert AlreadyClaimed();
        amount = (him.getPastVotes(msg.sender, snapshotBlock) * RATE) / 1e18;
        uint256 left = husd.balanceOf(address(this));
        if (amount > left) amount = left;
        // slither-disable-next-line incorrect-equality
        if (amount == 0) revert NothingToClaim();
        claimed[msg.sender] = true;
        emit Claimed(msg.sender, amount);
        husd.safeTransfer(msg.sender, amount);
    }
}
