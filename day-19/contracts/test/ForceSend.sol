// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title ForceSend — TEST ONLY. Pushes ETH into any address with selfdestruct, even one whose
///        receive() reverts. Used to show that force-sent ETH cannot fake the engine's backing.
contract ForceSend {
    constructor(address payable target) payable {
        selfdestruct(target);
    }
}
