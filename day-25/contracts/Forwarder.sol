// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title Forwarder — lets a user act on-chain without holding ETH (ERC-2771)
/// @author Manish Khadka
/// @notice The user signs an EIP-712 "ForwardRequest" (free, off-chain). A relayer
///         sends it here and pays the gas. The Forwarder checks the signature and
///         calls the target with the user's address glued to the end of the call
///         data, so the target (an ERC2771Context contract) knows who really asked.
/// @dev    Every check that protects the USER lives here, on-chain, because the
///         relayer is not trusted:
///         - the signature must come from `from`              (no acting as someone else)
///         - `nonce` must be the signer's next nonce, used once (no replay, no reordering)
///         - `deadline` must not have passed                  (no holding a signature for later)
///         - the EIP-712 domain includes chain ID + this address (no replay on another chain or forwarder)
///         - the relayer must forward exactly `value` and enough `gas` (no griefing)
///         - the target must trust this forwarder              (no calls to contracts that would
///                                                              mistake the forwarder for the user)
contract Forwarder is EIP712 {
    /// @notice What the user signs. Every field is covered by the signature.
    struct ForwardRequest {
        address from;     // the user
        address to;       // the contract to call
        uint256 value;    // wei to send with the call (the relayer must provide it)
        uint256 gas;      // gas the inner call must receive
        uint256 nonce;    // the user's next nonce in THIS forwarder
        uint48 deadline;  // unix time after which the request is dead
        bytes data;       // the function call, e.g. addTask("Buy milk")
    }

    bytes32 public constant FORWARD_REQUEST_TYPEHASH = keccak256(
        "ForwardRequest(address from,address to,uint256 value,uint256 gas,uint256 nonce,uint48 deadline,bytes data)"
    );

    /// @dev Gas the CALL opcode itself may take before forwarding (cold address 2,600
    ///      + value transfer 9,000 + memory), with room to spare.
    uint256 private constant CALL_OVERHEAD = 15_000;
    /// @dev At most this much of a failed call's revert data is kept (enough for any normal error).
    uint256 private constant MAX_REVERT_BYTES = 256;

    /// @notice user => next nonce. Nonces are sequential: 0, 1, 2, ...
    mapping(address => uint256) public nonces;

    event Executed(address indexed from, address indexed to, uint256 nonce, address relayer);

    error ValueMismatch(uint256 requested, uint256 sent);
    error Expired(uint48 deadline);
    error BadNonce(uint256 expected, uint256 got);
    error BadSignature();
    error UntrustfulTarget(address target);
    error NotEnoughGas(uint256 requested);
    error CallFailed(bytes reason);

    constructor() EIP712("Day25Forwarder", "1") {}

    /// @notice Would `execute` accept this request right now? (Free to call with eth_call.)
    function verify(ForwardRequest calldata req, bytes calldata signature) external view returns (bool) {
        return req.deadline >= block.timestamp
            && req.nonce == nonces[req.from]
            && _signerOf(req, signature) == req.from
            && _trusts(req.to);
    }

    /// @notice Run a signed request. Anyone may call this (usually a relayer);
    ///         the outcome is the same whoever sends it.
    function execute(ForwardRequest calldata req, bytes calldata signature) external payable {
        if (msg.value != req.value) revert ValueMismatch(req.value, msg.value);
        if (req.deadline < block.timestamp) revert Expired(req.deadline);
        uint256 expected = nonces[req.from];
        if (req.nonce != expected) revert BadNonce(expected, req.nonce);
        if (_signerOf(req, signature) != req.from) revert BadSignature();
        if (!_trusts(req.to)) revert UntrustfulTarget(req.to);

        // Effects before the call: the nonce is spent BEFORE the target runs, so a
        // re-entrant call can't use the same request twice. (If the call fails, the
        // whole transaction reverts, the nonce and the event included.)
        nonces[req.from] = expected + 1;
        emit Executed(req.from, req.to, expected, msg.sender);

        bytes memory callData = abi.encodePacked(req.data, req.from); // ERC-2771: the real sender rides in the last 20 bytes
        address to = req.to;
        uint256 value = req.value;
        uint256 gasLimit = req.gas;

        // Insufficient-gas griefing (SWC-126): a relayer could send the tx with too little
        // gas, so the inner call gets less than `req.gas` (a CALL passes on at most 63/64
        // of what is left). A target that catches its own out-of-gas would then "succeed"
        // without doing the work, and the user's nonce would be gone. So check BEFORE the
        // call that the full `req.gas` will really be passed on (+ margin for the CALL itself).
        if (gasleft() < (gasLimit * 64) / 63 + CALL_OVERHEAD) revert NotEnoughGas(gasLimit);

        // The call copies NO return data into memory: a target can't "return-bomb" us
        // with megabytes of output that the relayer would pay to copy.
        bool success;
        // solhint-disable-next-line no-inline-assembly
        assembly ("memory-safe") {
            success := call(gasLimit, to, value, add(callData, 0x20), mload(callData), 0, 0)
        }

        // A failed call reverts the whole thing, so the nonce is NOT used and the user
        // can try again. (The relayer simulates first, so it never pays for this.)
        if (!success) revert CallFailed(_returnDataUpTo(MAX_REVERT_BYTES));
    }

    /// @notice The EIP-712 domain separator (name, version, chain ID, this address).
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @dev Who signed this request? Returns address(0) for any malformed or
    ///      high-s (malleable) signature instead of reverting.
    function _signerOf(ForwardRequest calldata req, bytes calldata signature) private view returns (address) {
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            FORWARD_REQUEST_TYPEHASH,
            req.from, req.to, req.value, req.gas, req.nonce, req.deadline,
            keccak256(req.data)
        )));
        // slither-disable-next-line unused-return
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        return err == ECDSA.RecoverError.NoError ? signer : address(0);
    }

    /// @dev Does `target` say it trusts this forwarder? A contract that does NOT
    ///      read the appended sender would see msg.sender = this forwarder, so we
    ///      refuse to call it. Bounded gas, only 32 bytes of answer are read, and
    ///      anything but exactly `true` counts as "no".
    function _trusts(address target) private view returns (bool) {
        bytes memory query = abi.encodeWithSignature("isTrustedForwarder(address)", address(this));
        bool ok;
        uint256 returned;
        uint256 answer;
        // solhint-disable-next-line no-inline-assembly
        assembly ("memory-safe") {
            ok := staticcall(30000, target, add(query, 0x20), mload(query), 0, 0x20)
            returned := returndatasize()
            answer := mload(0)
        }
        return ok && returned == 32 && answer == 1;
    }

    /// @dev Copy at most `max` bytes of the last call's return data.
    function _returnDataUpTo(uint256 max) private pure returns (bytes memory out) {
        uint256 n;
        // solhint-disable-next-line no-inline-assembly
        assembly ("memory-safe") { n := returndatasize() }
        if (n > max) n = max;
        out = new bytes(n);
        // solhint-disable-next-line no-inline-assembly
        assembly ("memory-safe") { returndatacopy(add(out, 0x20), 0, n) }
    }
}
