// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/// @title HimalStakingV2Clash — DO NOT USE. A "V2" with a storage layout clash (QA.md F-04)
/// @notice The developer rewrote the contract and put the new variable `withdrawFeeBps` at
///         the TOP. The proxy's storage does not move, so every old variable is now read from
///         the slot BEFORE its own:
///           withdrawFeeBps ← slot 0 (was stakingToken: an address read as a huge fee)
///           stakingToken   ← slot 1 (was rewardsToken: withdrawals now pay the WRONG token)
///           totalStaked    ← slot 8 (was the balanceOf mapping's root slot: reads 0)
///           balanceOf      ← slot 9 (was the userRewardPerTokenPaid mapping: everyone's
///                                    "balance" is now a reward checkpoint)
///         It also drops ReentrancyGuard, whose namespaced storage the plugin also flags.
///         The OpenZeppelin upgrades plugin refuses this contract; the tests force it in by
///         calling `upgradeToAndCall` directly to show the damage.
/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract HimalStakingV2Clash is OwnableUpgradeable, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    uint256 public withdrawFeeBps; // ← NEW variable inserted first: the bug
    IERC20 public stakingToken;
    IERC20 public rewardsToken;
    uint256 public periodFinish;
    uint256 public rewardRateScaled;
    uint256 public lastUpdateTime;
    uint256 public rewardPerTokenStored;
    uint256 public unallocatedScaled;
    uint256 public totalStaked;
    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function version() external pure returns (string memory) {
        return "2.0.0-clash";
    }

    /// @notice Same withdraw as V1 (without the fee, to keep the demo short).
    function withdraw(uint256 amount) external {
        uint256 bal = balanceOf[msg.sender];
        require(amount <= bal, "balance");
        balanceOf[msg.sender] = bal - amount;
        totalStaked -= amount;
        stakingToken.safeTransfer(msg.sender, amount);
    }

    // solhint-disable-next-line no-empty-blocks
    function _authorizeUpgrade(address) internal override onlyOwner {}
}
