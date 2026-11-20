// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {HimalStakingV1} from "../upgrade/HimalStakingV1.sol";

/// @title HimalStakingV1OpenUpgrade — DO NOT USE (QA.md F-01)
/// @notice `_authorizeUpgrade` was left empty, so ANYONE can point the proxy at their own code.
/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract HimalStakingV1OpenUpgrade is HimalStakingV1 {
    // solhint-disable-next-line no-empty-blocks
    function _authorizeUpgrade(address) internal override {}
}
