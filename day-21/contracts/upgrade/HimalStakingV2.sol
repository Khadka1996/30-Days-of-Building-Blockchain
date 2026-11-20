// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {HimalStakingV1} from "./HimalStakingV1.sol";

/// @title HimalStakingV2 — V1 plus an emergency pause for NEW stakes
/// @author Manish Khadka (30 Days of Building Blockchain, Day 21)
/// @notice New in V2: a guardian (or the owner) can pause new stakes if something looks wrong.
///         Withdrawing and claiming rewards are NEVER paused: a pause must not trap anyone's money.
/// @dev Safe upgrade rules followed here:
///      - inherits V1, so every V1 variable keeps its slot; the two new variables are
///        APPENDED after V1's last slot [10] (OpenZeppelin's upgrades plugin checks this);
///      - V2 setup runs through `initializeV2`, a `reinitializer(2)` that only the owner can
///        call, sent together with the upgrade in one transaction (`upgradeToAndCall`) (F-06).
///      V2 has no new `initializer`: the inherited V1 `initialize` already sets up every parent,
///      and existing proxies reach V2 only by upgrading, so the plugin's "missing initializer"
///      check is switched off on purpose.
/// @custom:oz-upgrades-from HimalStakingV1
/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract HimalStakingV2 is HimalStakingV1 {
    // ── storage added in v2: appended after V1's slot [10] ──
    address public guardian; //  [11]
    bool public stakingPaused; // [11] (packed next to guardian)

    event GuardianSet(address indexed guardian);
    event StakingPaused(bool paused);

    error StakingIsPaused();
    error NotGuardian();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice One-time V2 setup. Runs once, only for the owner (F-06).
    function initializeV2(address guardian_) external reinitializer(2) onlyOwner {
        if (guardian_ == address(0)) revert ZeroAddress();
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    function version() external pure override returns (string memory) {
        return "2.0.0";
    }

    /// @notice Pause or resume NEW stakes. Withdrawals and rewards keep working.
    function setStakingPaused(bool paused) external {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardian();
        stakingPaused = paused;
        emit StakingPaused(paused);
    }

    function stake(uint256 amount) public override {
        if (stakingPaused) revert StakingIsPaused();
        super.stake(amount);
    }
}
