// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @notice What a contract must implement to receive cross-chain messages.
interface IMessageReceiver {
    /// @param srcChainId the chain the message came from
    /// @param sender     who called `sendMessage` on the source chain
    /// @param data       the message body
    function onMessage(uint256 srcChainId, address sender, bytes calldata data) external;
}

/// @title Day 26 — a small cross-chain messenger (one copy on each chain)
/// @author Manish Khadka
/// @notice Like a registered letter between two post offices:
///  - On the source chain, `sendMessage` writes the letter into an event with a fresh number.
///  - Off-chain validators watch that event, wait for confirmations, and each sign the letter.
///  - On the destination chain, `receiveMessage` checks the signatures (M of N), the
///    address on the envelope (this chain, this messenger) and that the letter number
///    was never delivered before, then hands the body to the target contract.
///
/// Security focus: replay across chains and bridge risks.
///  - The signed hash includes BOTH chain IDs and BOTH messenger addresses, so a
///    signature for chain B can never be used on chain A, or on a second copy on B.
///  - Each message id is delivered at most once (`processed`), marked BEFORE the call.
///  - One stolen validator key is not enough: `threshold` distinct validators must sign.
///  - Only messages from the one trusted messenger on each known source chain are accepted.
///  - The owner (a multisig in real life) can pause sending and receiving in an emergency.
contract Messenger is Ownable2Step, Pausable, ReentrancyGuard {
    /// @notice A cross-chain message. Its hash is what validators sign.
    struct Message {
        uint256 srcChainId;
        address srcMessenger;
        uint256 dstChainId;
        address dstMessenger;
        uint256 nonce;
        address sender;
        address target;
        bytes data;
    }

    bytes32 public constant MESSAGE_TYPEHASH = keccak256(
        "Message(uint256 srcChainId,address srcMessenger,uint256 dstChainId,address dstMessenger,uint256 nonce,address sender,address target,bytes data)"
    );
    uint256 public constant MAX_DATA_BYTES = 1024;
    uint256 public constant MAX_VALIDATORS = 16;

    /// @notice Validator set and how many of them must sign (fixed at deploy).
    address[] private _validators;
    mapping(address => bool) public isValidator;
    uint256 public immutable threshold;

    /// @notice The trusted messenger on each remote chain (0 = not connected).
    mapping(uint256 chainId => address messenger) public remotes;
    /// @notice Next outgoing nonce.
    uint256 public nextNonce;
    /// @notice Message ids already delivered here.
    mapping(bytes32 id => bool) public processed;

    event RemoteSet(uint256 indexed chainId, address messenger);
    event MessageSent(bytes32 indexed id, uint256 indexed dstChainId, Message message);
    event MessageReceived(bytes32 indexed id, uint256 indexed srcChainId, uint256 nonce, address sender, address target);

    error BadValidatorSet();
    error UnknownDestination(uint256 chainId);
    error DataTooLarge();
    error BadTarget();
    error WrongDestinationChain(uint256 expected, uint256 actual);
    error WrongDestinationMessenger();
    error UnknownSource(uint256 chainId, address messenger);
    error AlreadyProcessed(bytes32 id);
    error NotEnoughSignatures(uint256 given, uint256 needed);
    error SignersNotSortedOrDuplicate();
    error NotAValidator(address signer);

    constructor(address[] memory validators_, uint256 threshold_, address owner_) Ownable(owner_) {
        uint256 n = validators_.length;
        // threshold must be a strict majority: 2 of 3, 3 of 5... never 1 of N
        if (n == 0 || n > MAX_VALIDATORS || threshold_ * 2 <= n || threshold_ > n) revert BadValidatorSet();
        for (uint256 i = 0; i < n; i++) {
            address v = validators_[i];
            if (v == address(0) || isValidator[v]) revert BadValidatorSet();
            isValidator[v] = true;
            _validators.push(v);
        }
        threshold = threshold_;
    }

    // ------------------------------------------------------------------ admin

    /// @notice Connect (or disconnect with address 0) the trusted messenger on another chain.
    function setRemote(uint256 chainId, address messenger) external onlyOwner {
        if (chainId == block.chainid || chainId == 0) revert UnknownDestination(chainId);
        remotes[chainId] = messenger;
        emit RemoteSet(chainId, messenger);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    function validators() external view returns (address[] memory) { return _validators; }

    // ------------------------------------------------------------------- send

    /// @notice Send `data` to `target` on chain `dstChainId`. Returns the message id.
    function sendMessage(uint256 dstChainId, address target, bytes calldata data)
        external
        whenNotPaused
        returns (bytes32 id)
    {
        address dstMessenger = remotes[dstChainId];
        if (dstMessenger == address(0)) revert UnknownDestination(dstChainId);
        if (target == address(0)) revert BadTarget();
        if (data.length > MAX_DATA_BYTES) revert DataTooLarge();

        Message memory m = Message({
            srcChainId: block.chainid,
            srcMessenger: address(this),
            dstChainId: dstChainId,
            dstMessenger: dstMessenger,
            nonce: nextNonce++,
            sender: msg.sender,
            target: target,
            data: data
        });
        id = hashMessage(m);
        emit MessageSent(id, dstChainId, m);
    }

    // ---------------------------------------------------------------- receive

    /// @notice Deliver a message signed by at least `threshold` validators.
    /// @param signatures 65-byte signatures, ordered by signer address (ascending).
    /// @dev If the target reverts, the whole call reverts and the message stays
    ///      undelivered, so it can be retried later (nothing is lost).
    function receiveMessage(Message calldata m, bytes[] calldata signatures)
        external
        whenNotPaused
        nonReentrant
    {
        // 1. the envelope must be addressed to THIS chain and THIS messenger (cross-chain replay)
        if (m.dstChainId != block.chainid) revert WrongDestinationChain(block.chainid, m.dstChainId);
        if (m.dstMessenger != address(this)) revert WrongDestinationMessenger();
        // 2. it must come from the one messenger we trust on that chain (forged sources)
        address trusted = remotes[m.srcChainId];
        if (trusted == address(0) || m.srcMessenger != trusted) revert UnknownSource(m.srcChainId, m.srcMessenger);
        // 3. at most once (same-chain replay)
        bytes32 id = hashMessage(m);
        if (processed[id]) revert AlreadyProcessed(id);
        // 4. enough distinct validators signed exactly this message (one stolen key is not enough)
        _checkSignatures(id, signatures);

        // effects before the external call
        processed[id] = true;
        emit MessageReceived(id, m.srcChainId, m.nonce, m.sender, m.target);

        IMessageReceiver(m.target).onMessage(m.srcChainId, m.sender, m.data);
    }

    /// @notice The id of a message: an EIP-712-style struct hash of every field.
    function hashMessage(Message memory m) public pure returns (bytes32) {
        return keccak256(abi.encode(
            MESSAGE_TYPEHASH, m.srcChainId, m.srcMessenger, m.dstChainId, m.dstMessenger,
            m.nonce, m.sender, m.target, keccak256(m.data)
        ));
    }

    function _checkSignatures(bytes32 id, bytes[] calldata signatures) private view {
        if (signatures.length < threshold) revert NotEnoughSignatures(signatures.length, threshold);
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(id);
        address last = address(0);
        for (uint256 i = 0; i < threshold; i++) {
            // OpenZeppelin's ECDSA rejects malleable (high-s) and malformed signatures
            address signer = ECDSA.recover(digest, signatures[i]);
            if (signer <= last) revert SignersNotSortedOrDuplicate(); // no counting one key twice
            if (!isValidator[signer]) revert NotAValidator(signer);
            last = signer;
        }
    }
}
