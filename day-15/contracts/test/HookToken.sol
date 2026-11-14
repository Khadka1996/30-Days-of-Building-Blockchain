// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface ITokenReceiver {
    function onTokenReceived(uint256 amount) external;
}

/// @dev TEST ONLY. Calls the receiver after every transfer (like ERC-777 hooks),
///      which gives an attacker a chance to re-enter the staking contract.
contract HookToken is ERC20 {
    constructor(uint256 supply) ERC20("Hook Token", "HOOK") {
        _mint(msg.sender, supply);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from != address(0) && to.code.length > 0) {
            // solhint-disable-next-line no-empty-blocks
            try ITokenReceiver(to).onTokenReceived(value) {} catch (bytes memory reason) {
                // Receivers without the hook revert with no data: ignore them.
                // Any other revert is bubbled up so the test sees why the re-entry failed.
                if (reason.length > 0) {
                    // solhint-disable-next-line no-inline-assembly
                    assembly { revert(add(reason, 32), mload(reason)) }
                }
            }
        }
    }
}
