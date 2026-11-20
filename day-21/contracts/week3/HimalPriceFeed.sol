// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title HimalPriceFeed — a Chainlink-shaped price feed for the local network
/// @notice Stand-in for a Chainlink price feed (there is no Chainlink on a local Hardhat node).
///         It has the same `latestRoundData()` shape, so HimalLend would work with a real feed
///         unchanged. The price is the value of 1 HIM in HUSD with 8 decimals ($10 = 10_00000000).
///         Unlike a pool's spot price, nobody can move it by trading: only the reporter can update it.
contract HimalPriceFeed is Ownable {
    // Named like Chainlink's decimals() so consumers can call feed.decimals().
    // solhint-disable-next-line const-name-snakecase
    uint8 public constant decimals = 8;

    uint80 private _roundId;
    int256 private _answer;
    uint256 private _updatedAt;

    event PriceUpdated(uint80 indexed roundId, int256 answer, uint256 updatedAt);

    constructor(int256 initialPrice, address reporter) Ownable(reporter) {
        _set(initialPrice);
    }

    /// @notice The reporter posts a new price. Consumers decide how old a price they accept.
    function setPrice(int256 answer) external onlyOwner {
        _set(answer);
    }

    /// @notice Same return values as Chainlink's AggregatorV3Interface.
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return (_roundId, _answer, _updatedAt, _updatedAt, _roundId);
    }

    function _set(int256 answer) private {
        _roundId += 1;
        _answer = answer;
        _updatedAt = block.timestamp;
        emit PriceUpdated(_roundId, answer, block.timestamp);
    }
}
