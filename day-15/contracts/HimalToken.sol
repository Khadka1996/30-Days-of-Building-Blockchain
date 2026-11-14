// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title HimalToken — a plain fixed-supply ERC-20
/// @notice Used twice on Day 15: HIM (the token you stake) and HRW (the reward token).
///         The whole supply is minted once to `holder`; there is no mint function.
contract HimalToken is ERC20 {
    constructor(string memory name_, string memory symbol_, uint256 supply, address holder) ERC20(name_, symbol_) {
        _mint(holder, supply);
    }
}
