// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @title SmartWallet — a tiny contract wallet that can "Sign in with Ethereum"
/// @author Manish Khadka
/// @notice A contract has no private key, so it cannot sign anything itself.
///         ERC-1271 lets it say "yes, this signature counts as mine": here, a
///         signature is valid when the wallet's owner key made it.
///         Login servers must ask the contract (isValidSignature) instead of
///         only running ecrecover, or smart-wallet users can never log in.
contract SmartWallet is IERC1271 {
    /// @dev ERC-1271 "valid" answer: bytes4(keccak256("isValidSignature(bytes32,bytes)")).
    bytes4 internal constant MAGIC_VALUE = 0x1626ba7e;

    /// @notice The key allowed to act (and sign) for this wallet.
    // solhint-disable-next-line immutable-vars-naming
    address public immutable owner;

    error ZeroOwner();
    error NotOwner();
    error CallFailed();
    error ZeroTarget();

    constructor(address owner_) {
        if (owner_ == address(0)) revert ZeroOwner();
        owner = owner_;
    }

    /// @notice ERC-1271: is `signature` a valid signature of `hash` for this wallet?
    /// @dev tryRecover never reverts and never returns a garbage signer as valid:
    ///      malformed or malleable (high-s) signatures give an error, so we answer "no".
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecover(hash, signature);
        if (err == ECDSA.RecoverError.NoError && signer == owner) return MAGIC_VALUE;
        return 0xffffffff;
    }

    /// @notice Let the owner use the wallet (e.g. add a task to the Day 1 to-do list).
    function execute(address target, uint256 value, bytes calldata data) external returns (bytes memory result) {
        if (msg.sender != owner) revert NotOwner();
        if (target == address(0)) revert ZeroTarget(); // a call to 0x0 "succeeds" and would silently burn ETH
        bool ok;
        (ok, result) = target.call{value: value}(data);
        if (!ok) revert CallFailed();
    }

    receive() external payable {}
}
