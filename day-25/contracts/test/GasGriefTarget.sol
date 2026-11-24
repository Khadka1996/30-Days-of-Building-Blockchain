// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/* solhint-disable */ // test-only helper: deliberately odd code

import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";

/// @dev TEST ONLY. A target that "swallows" an out-of-gas error: `work()` tries
///      `heavy()` and, if it fails, quietly returns. A relayer that sends too
///      little gas could make `heavy()` fail while the user's request still
///      counts as done. The Forwarder's 63/64 gas check must stop that.
contract GasGriefTarget is ERC2771Context {
    uint256 public done;
    uint256 private _sink;

    constructor(address forwarder) ERC2771Context(forwarder) {
        _sink = 1; // non-zero, so every heavy() costs the same
    }

    function work() external {
        // keeps 20k gas back for itself (common for clean-up code), so after a
        // failed heavy() it still has gas to return "success"
        try this.heavy{gas: gasleft() - 20_000}() {
            done += 1;
        } catch {
            return; // swallowed: cheap on purpose
        }
    }

    function heavy() external {
        // ~80k gas of plain work, the same every time
        uint256 x = _sink;
        unchecked {
            for (uint256 i = 0; i < 1000; ++i) x = x * 7 + i;
        }
        _sink = x | 1;
    }
}
