// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {BitMaps} from "@openzeppelin/contracts/utils/structs/BitMaps.sol";

/// @title MerkleAirdrop
/// @author Manish Khadka
/// @notice Pays a list of people (for example 1,000 addresses) while storing only ONE hash
///         on-chain: the Merkle root. Each person proves "I am on the list for this amount"
///         with about 10 hashes that they supply themselves when they claim.
/// @dev Rules:
///      - Each leaf is keccak256(keccak256(abi.encode(index, account, amount))). The double
///        hash means a 64-byte inner node of the tree can never be passed off as a leaf.
///      - The leaf is built from msg.sender, so a proof copied from the mempool is useless.
///      - Claims are tracked in a bitmap by index, which stores 256 claims per storage slot.
///      - There is no owner. Unclaimed tokens can only go to the treasury, only after the deadline.
contract MerkleAirdrop {
    using SafeERC20 for IERC20;
    using BitMaps for BitMaps.BitMap;

    /// @notice Shortest and longest claim window allowed.
    uint256 public constant MIN_CLAIM_PERIOD = 1 days;
    uint256 public constant MAX_CLAIM_PERIOD = 365 days;

    // solhint-disable-next-line immutable-vars-naming
    IERC20 public immutable token;
    /// @notice The single hash that represents the whole list. It can never change.
    // solhint-disable-next-line immutable-vars-naming
    bytes32 public immutable merkleRoot;
    /// @notice The only address that can fund the airdrop or receive what is left over.
    // solhint-disable-next-line immutable-vars-naming
    address public immutable treasury;
    /// @notice The sum of every amount on the list.
    // solhint-disable-next-line immutable-vars-naming
    uint256 public immutable totalAllocation;
    /// @notice How long people have to claim, counted from the moment of funding.
    // solhint-disable-next-line immutable-vars-naming
    uint256 public immutable claimPeriod;

    /// @notice Last second a claim is allowed. Zero means not funded yet.
    uint256 public deadline;
    /// @notice Tokens paid out so far.
    uint256 public totalClaimed;

    BitMaps.BitMap private _claimed;

    event Funded(uint256 amount, uint256 deadline);
    event Claimed(uint256 indexed index, address indexed account, uint256 amount);
    event Swept(address indexed treasury, uint256 amount);

    error ZeroAddress();
    error ZeroRoot();
    error ZeroAllocation();
    error BadClaimPeriod();
    error NotTreasury();
    error AlreadyFunded();
    error InsufficientFunding();
    error NotFunded();
    error ClaimsClosed();
    error ClaimsStillOpen();
    error AlreadyClaimed(uint256 index);
    error InvalidProof();
    error ExceedsAllocation();
    error NothingToSweep();

    constructor(IERC20 token_, bytes32 merkleRoot_, address treasury_, uint256 totalAllocation_, uint256 claimPeriod_) {
        if (address(token_) == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (merkleRoot_ == bytes32(0)) revert ZeroRoot();
        if (totalAllocation_ == 0) revert ZeroAllocation();
        if (claimPeriod_ < MIN_CLAIM_PERIOD || claimPeriod_ > MAX_CLAIM_PERIOD) revert BadClaimPeriod();
        token = token_;
        merkleRoot = merkleRoot_;
        treasury = treasury_;
        totalAllocation = totalAllocation_;
        claimPeriod = claimPeriod_;
    }

    /// @notice The treasury deposits the full amount, which opens the claim window.
    /// @dev The treasury must approve this contract first. The window starts here, so people
    ///      always get the full claim period however late the funding happens.
    function fund() external {
        if (msg.sender != treasury) revert NotTreasury();
        if (deadline != 0) revert AlreadyFunded();

        // solhint-disable-next-line not-rely-on-time -- a deadline needs a clock; validators can only shift it by seconds
        uint256 newDeadline = block.timestamp + claimPeriod;
        deadline = newDeadline;

        emit Funded(totalAllocation, newDeadline);

        token.safeTransferFrom(msg.sender, address(this), totalAllocation);
        // A token that charges a fee on transfer would leave the contract short: stop here.
        if (token.balanceOf(address(this)) < totalAllocation) revert InsufficientFunding();
    }

    /// @notice Claim your tokens. The proof comes from the published list.
    /// @param index Your position on the list.
    /// @param amount The amount the list gives you.
    /// @param proof The sibling hashes from your leaf up to the root.
    function claim(uint256 index, uint256 amount, bytes32[] calldata proof) external {
        uint256 currentDeadline = deadline;
        // 0 is the exact "not funded yet" marker, so a strict comparison is correct.
        // slither-disable-next-line incorrect-equality
        if (currentDeadline == 0) revert NotFunded();
        // solhint-disable-next-line not-rely-on-time -- see fund()
        if (block.timestamp > currentDeadline) revert ClaimsClosed();
        if (_claimed.get(index)) revert AlreadyClaimed(index);
        if (!_verify(index, msg.sender, amount, proof)) revert InvalidProof();

        // A bad list whose amounts add up to more than the total must not drain other people's share.
        uint256 newTotal = totalClaimed + amount;
        if (newTotal > totalAllocation) revert ExceedsAllocation();

        // Mark as claimed BEFORE paying, so a callback cannot claim twice.
        _claimed.set(index);
        totalClaimed = newTotal;

        emit Claimed(index, msg.sender, amount);
        token.safeTransfer(msg.sender, amount);
    }

    /// @notice After the deadline, anyone can send what is left to the treasury.
    function sweep() external {
        uint256 currentDeadline = deadline;
        // 0 is the exact "not funded yet" marker, so a strict comparison is correct.
        // slither-disable-next-line incorrect-equality
        if (currentDeadline == 0) revert NotFunded();
        // solhint-disable-next-line not-rely-on-time -- see fund()
        if (block.timestamp <= currentDeadline) revert ClaimsStillOpen();

        uint256 remaining = token.balanceOf(address(this));
        // Empty really means nothing to do.
        // slither-disable-next-line incorrect-equality
        if (remaining == 0) revert NothingToSweep();

        emit Swept(treasury, remaining);
        token.safeTransfer(treasury, remaining);
    }

    /// @notice Has this position on the list been claimed?
    function isClaimed(uint256 index) external view returns (bool) {
        return _claimed.get(index);
    }

    /// @notice Check a proof without sending a transaction, for example from a claim page.
    function verifyProof(uint256 index, address account, uint256 amount, bytes32[] calldata proof)
        external
        view
        returns (bool)
    {
        return _verify(index, account, amount, proof);
    }

    function _verify(uint256 index, address account, uint256 amount, bytes32[] calldata proof)
        private
        view
        returns (bool)
    {
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))));
        return MerkleProof.verifyCalldata(proof, merkleRoot, leaf);
    }
}
