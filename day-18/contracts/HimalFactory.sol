// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HimalPair} from "./HimalPair.sol";

/// @title HimalFactory — creates one HimalPair per token pair and remembers where it is
/// @notice Anyone can create a pool for two tokens, once. The router uses `getPair` to find pools.
contract HimalFactory {
    /// @notice getPair[tokenA][tokenB] == getPair[tokenB][tokenA] == the pool's address (or 0).
    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    event PairCreated(address indexed token0, address indexed token1, address pair, uint256 count);

    error IdenticalTokens();
    error ZeroAddress();
    error PairExists();

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        if (tokenA == tokenB) revert IdenticalTokens();
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        if (token0 == address(0)) revert ZeroAddress();
        if (getPair[token0][token1] != address(0)) revert PairExists();

        pair = address(new HimalPair(IERC20(token0), IERC20(token1)));
        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair;
        allPairs.push(pair);
        emit PairCreated(token0, token1, pair, allPairs.length);
    }
}
