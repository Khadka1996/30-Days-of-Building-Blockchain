// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev TEST ONLY. A dollar-style token with 6 decimals (like USDC), used to show rounding loss.
contract SixDecimalToken is ERC20 {
    constructor(uint256 supply) ERC20("Six Decimal Dollar", "USD6") {
        _mint(msg.sender, supply);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}
