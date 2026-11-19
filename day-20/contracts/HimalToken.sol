// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title HimalToken — a plain fixed-supply ERC-20
/// @notice On Day 20 it is HUSD, the dollar token people deposit into the vault.
///         The whole supply is minted once to `holder`; there is no mint function.
contract HimalToken is ERC20 {
    constructor(string memory name_, string memory symbol_, uint256 supply, address holder) ERC20(name_, symbol_) {
        _mint(holder, supply);
    }
}
