// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/* solhint-disable */ // test-only helper: deliberately odd code

/// @dev TEST ONLY. Answers isTrustedForwarder() with junk: the number 2, or a
///      64-byte answer whose first word is 1. Neither is a clean "true".
contract JunkTrust {
    uint256 public immutable mode;
    constructor(uint256 mode_) { mode = mode_; }

    function isTrustedForwarder(address) external view returns (bool) {
        uint256 m = mode;
        assembly {
            switch m
            case 0 { mstore(0, 2) return(0, 32) }
            default { mstore(0, 1) mstore(32, 0) return(0, 64) }
        }
    }

    function poke() external {}
}
