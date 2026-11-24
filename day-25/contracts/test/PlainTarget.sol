// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/* solhint-disable */ // test-only helper: deliberately odd code

/// @dev TEST ONLY. A contract that knows nothing about ERC-2771: it would see
///      msg.sender = the Forwarder. The Forwarder must refuse to call it.
contract PlainTarget {
    address public lastCaller;
    function poke() external { lastCaller = msg.sender; }
}
