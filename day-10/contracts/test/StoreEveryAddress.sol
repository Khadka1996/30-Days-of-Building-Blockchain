// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice TEST ONLY. The expensive way: store every allocation on-chain. Used to compare gas.
contract StoreEveryAddress {
    mapping(address account => uint256 amount) public allocation;

    function add(address[] calldata accounts, uint256[] calldata amounts) external {
        for (uint256 i = 0; i < accounts.length; i++) {
            allocation[accounts[i]] = amounts[i];
        }
    }
}
