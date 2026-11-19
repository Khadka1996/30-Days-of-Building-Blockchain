// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title NaiveVault — VULNERABLE ON PURPOSE, for the lesson. Never deploy it.
/// @notice The textbook share vault: shares = assets × supply ÷ totalAssets, with
///         totalAssets = the vault's token balance, no virtual shares and no 0-share check.
///         The first-depositor inflation attack steals the next deposit (see the tests).
contract NaiveVault is ERC20 {
    using SafeERC20 for IERC20;

    // solhint-disable-next-line immutable-vars-naming
    IERC20 public immutable asset;

    constructor(IERC20 asset_) ERC20("Naive Vault HUSD", "nvHUSD") {
        asset = asset_;
    }

    /// @dev BUG: anyone can raise this by sending tokens straight to the vault.
    function totalAssets() public view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    function deposit(uint256 assets) external returns (uint256 shares) {
        uint256 supply = totalSupply();
        // BUG: rounds down to 0 shares without complaint once the share price is inflated.
        shares = supply == 0 ? assets : (assets * supply) / totalAssets();
        asset.safeTransferFrom(msg.sender, address(this), assets);
        _mint(msg.sender, shares);
    }

    function redeem(uint256 shares) external returns (uint256 assets) {
        assets = (shares * totalAssets()) / totalSupply();
        _burn(msg.sender, shares);
        asset.safeTransfer(msg.sender, assets);
    }
}
