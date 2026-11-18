// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title EthUsdFeed — a Chainlink-shaped ETH/USD price feed for the local network
/// @notice Same `latestRoundData()` shape as Chainlink, with 8 decimals ($2,000 = 2000_00000000).
///         Like real Chainlink aggregators it has a built-in "circuit breaker" band:
///         `minAnswer` and `maxAnswer`. A price outside the band is CLAMPED to the edge.
///         That is how the LUNA feed kept reporting about $0.10 in May 2022 while LUNA traded far
///         lower, and lending pools that trusted it were drained. The DollarEngine refuses prices
///         that sit on the edge of the band.
contract EthUsdFeed is Ownable {
    // Named like Chainlink's decimals() so consumers can call feed.decimals().
    // solhint-disable-next-line const-name-snakecase
    uint8 public constant decimals = 8;

    // solhint-disable-next-line immutable-vars-naming
    int256 public immutable minAnswer;
    // solhint-disable-next-line immutable-vars-naming
    int256 public immutable maxAnswer;

    uint80 private _roundId;
    int256 private _answer;
    uint256 private _updatedAt;

    event PriceUpdated(uint80 indexed roundId, int256 answer, uint256 updatedAt);

    error BadBand();

    constructor(int256 initialPrice, int256 minAnswer_, int256 maxAnswer_, address reporter) Ownable(reporter) {
        if (minAnswer_ <= 0 || maxAnswer_ <= minAnswer_) revert BadBand();
        minAnswer = minAnswer_;
        maxAnswer = maxAnswer_;
        _set(initialPrice);
    }

    /// @notice The reporter posts a new price; it is clamped into [minAnswer, maxAnswer].
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
        if (answer < minAnswer) answer = minAnswer;
        if (answer > maxAnswer) answer = maxAnswer;
        _roundId += 1;
        _answer = answer;
        _updatedAt = block.timestamp;
        emit PriceUpdated(_roundId, answer, block.timestamp);
    }
}
