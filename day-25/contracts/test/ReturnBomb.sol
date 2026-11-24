// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/* solhint-disable */ // test-only helper: deliberately odd code

import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";

/// @dev TEST ONLY. Answers with a huge blob of bytes (a "return bomb"), on
///      success or on failure. Copying it would cost the caller lots of gas.
contract ReturnBomb is ERC2771Context {
    constructor(address forwarder) ERC2771Context(forwarder) {}

    function bomb(uint256 size, bool fail) external pure {
        assembly {
            switch fail
            case 0 { return(0, size) }
            default { revert(0, size) }
        }
    }
}
