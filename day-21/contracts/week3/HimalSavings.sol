// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title HimalSavings — the "investment" the yield vault puts its HUSD into
/// @notice A teaching stand-in for a real strategy (a lending market, a savings account).
///         Only the vault can put money in or take it out. Borrowers pay interest with
///         `payInterest`, which anyone can call. The deployer can simulate a borrower default
///         with `simulateLoss`, so the tests can check what the vault does when it loses money.
/// @dev The strategy counts its own assets (`_assets`) instead of reading its token balance,
///      so tokens sent to it directly do not change what it reports.
contract HimalSavings {
    using SafeERC20 for IERC20;

    // Lower-case names so the getters read like the ERC-4626 API (`asset()`).
    // solhint-disable immutable-vars-naming
    IERC20 public immutable asset;
    address public immutable deployer;
    // solhint-enable immutable-vars-naming
    address public vault;

    uint256 private _assets;

    event VaultSet(address indexed vault);
    event Invested(uint256 amount);
    event Returned(uint256 amount);
    event InterestPaid(address indexed payer, uint256 amount);
    event LossSimulated(uint256 amount);

    error OnlyVault(address caller);
    error OnlyDeployer(address caller);
    error VaultAlreadySet();
    error ZeroAddress();
    error ZeroAmount();
    error MoreThanHeld(uint256 requested, uint256 held);

    constructor(IERC20 asset_) {
        if (address(asset_) == address(0)) revert ZeroAddress();
        asset = asset_;
        deployer = msg.sender;
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault(msg.sender);
        _;
    }

    modifier onlyDeployer() {
        if (msg.sender != deployer) revert OnlyDeployer(msg.sender);
        _;
    }

    /// @notice Connect the vault, once. After this nobody can change it.
    function setVault(address vault_) external onlyDeployer {
        if (vault != address(0)) revert VaultAlreadySet();
        if (vault_ == address(0)) revert ZeroAddress();
        vault = vault_;
        emit VaultSet(vault_);
    }

    /// @notice What the strategy holds for the vault, including interest received.
    function totalAssets() external view returns (uint256) {
        return _assets;
    }

    function deposit(uint256 amount) external onlyVault {
        if (amount == 0) revert ZeroAmount();
        _assets += amount;
        emit Invested(amount);
        asset.safeTransferFrom(msg.sender, address(this), amount);
    }

    function withdraw(uint256 amount) external onlyVault {
        if (amount == 0) revert ZeroAmount();
        if (amount > _assets) revert MoreThanHeld(amount, _assets);
        _assets -= amount;
        emit Returned(amount);
        asset.safeTransfer(msg.sender, amount);
    }

    /// @notice Borrowers pay interest here. Anyone can call it, which also makes it a way to
    ///         "donate" to the vault: the vault's profit lock is what makes that harmless.
    function payInterest(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        _assets += amount;
        emit InterestPaid(msg.sender, amount);
        asset.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Test lever: a borrower defaults and `amount` HUSD is gone (sent to `to`).
    function simulateLoss(uint256 amount, address to) external onlyDeployer {
        if (amount > _assets) revert MoreThanHeld(amount, _assets);
        _assets -= amount;
        emit LossSimulated(amount);
        asset.safeTransfer(to, amount);
    }
}
