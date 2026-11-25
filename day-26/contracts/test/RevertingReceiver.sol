// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IMessageReceiver} from "../Messenger.sol";

/// @dev Test only: refuses messages until `open` is set, to prove a failed
///      delivery can be retried later and is not lost.
contract RevertingReceiver is IMessageReceiver {
    bool public open;
    uint256 public deliveries;
    function setOpen(bool o) external { open = o; }
    function onMessage(uint256, address, bytes calldata) external {
        require(open, "closed");
        deliveries++;
    }
}
