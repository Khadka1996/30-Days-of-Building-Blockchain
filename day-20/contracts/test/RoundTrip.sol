// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

/// @notice Test helper: deposit and redeem in ONE transaction, then send everything back.
///         Used by the fuzz test to prove a same-block round trip never makes money.
contract RoundTrip {
    function run(IERC4626 vault, uint256 assets) external returns (uint256 back) {
        IERC20 token = IERC20(vault.asset());
        require(token.transferFrom(msg.sender, address(this), assets), "pull");
        token.approve(address(vault), assets);
        uint256 shares = vault.deposit(assets, address(this));
        back = vault.redeem(shares, msg.sender, address(this));
    }
}
