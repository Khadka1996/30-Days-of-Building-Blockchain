// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {HimalStakingV1} from "../upgrade/HimalStakingV1.sol";

/// @title HimalStakingV2OpenInit — DO NOT USE (QA.md F-06)
/// @notice The V2 setup function is a `reinitializer(2)` with no owner check. If the upgrade and
///         the setup are sent as two transactions, anyone can call it first and pick the guardian.
/// @custom:oz-upgrades-from HimalStakingV1
/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract HimalStakingV2OpenInit is HimalStakingV1 {
    address public guardian;

    function initializeV2(address guardian_) external reinitializer(2) {
        guardian = guardian_;
    }
}
