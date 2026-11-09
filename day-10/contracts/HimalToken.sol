// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title HimalToken (HIM)
/// @author Manish Khadka
/// @notice My own ERC-20 token. The whole supply (1,000,000 HIM) is created once, at deploy,
///         and sent to the deployer. There is no mint function, so nobody (not even the
///         deployer) can ever create more tokens later.
/// @dev Plain OpenZeppelin ERC-20: no fees, no hooks, no owner. 18 decimals like ETH.
contract HimalToken is ERC20 {
    /// @notice The fixed total supply: 1,000,000 tokens with 18 decimals.
    uint256 public constant TOTAL_SUPPLY = 1_000_000 ether;

    constructor() ERC20("Himal Token", "HIM") {
        _mint(msg.sender, TOTAL_SUPPLY);
    }
}
