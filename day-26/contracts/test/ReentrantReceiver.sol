// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Messenger, IMessageReceiver} from "../Messenger.sol";

/// @dev Test only: when it receives a message it tries to make the Messenger
///      deliver the same message again (re-entrancy + replay in one go).
contract ReentrantReceiver is IMessageReceiver {
    Messenger public immutable messenger;
    bytes public replayCall;     // abi-encoded receiveMessage call to replay
    bool public replaySucceeded;
    uint256 public deliveries;

    constructor(Messenger m) { messenger = m; }

    function setReplay(bytes calldata callData) external { replayCall = callData; }

    function onMessage(uint256, address, bytes calldata) external {
        deliveries++;
        if (replayCall.length > 0) {
            // solhint-disable-next-line avoid-low-level-calls
            (bool ok, ) = address(messenger).call(replayCall);
            replaySucceeded = ok;
        }
    }
}
