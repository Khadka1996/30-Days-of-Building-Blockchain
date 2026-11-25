// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Messenger} from "../Messenger.sol";

/// @dev Test only: an attacker's contract that emits a perfect-looking
///      MessageSent event. Validators must ignore events not emitted by the
///      real Messenger.
contract FakeMessenger {
    event MessageSent(bytes32 indexed id, uint256 indexed dstChainId, Messenger.Message message);
    function fake(Messenger.Message calldata m, bytes32 id) external {
        emit MessageSent(id, m.dstChainId, m);
    }
}
