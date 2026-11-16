// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev TEST ONLY. Like an ERC-777 token: on every transfer it calls back into `target` with `data`,
///      once. Used to try to re-enter a pair in the middle of a swap.
contract HookToken is ERC20 {
    address public target;
    bytes public data;
    bool private armed;

    constructor(uint256 supply, address holder) ERC20("Hook Token", "HOOK") {
        _mint(holder, supply);
    }

    function arm(address target_, bytes calldata data_) external {
        (target, data, armed) = (target_, data_, true);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed) {
            armed = false;
            // solhint-disable-next-line avoid-low-level-calls
            (bool ok, bytes memory ret) = target.call(data);
            if (!ok) {
                // Bubble up the inner revert so the test can see why it failed.
                // solhint-disable-next-line no-inline-assembly
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
    }
}
