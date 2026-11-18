// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title BrokenFeed — TEST ONLY. A feed whose every return value can be set, to test the engine's checks.
contract BrokenFeed {
    uint8 public decimals = 8;
    int256 public minAnswer = 1_00000000; // $1
    int256 public maxAnswer = 1_000_000_00000000; // $1,000,000
    uint80 public roundId = 1;
    int256 public answer = 2_000_00000000;
    uint256 public updatedAt;
    uint80 public answeredInRound = 1;

    constructor() {
        updatedAt = block.timestamp;
    }

    function setRound(uint80 r, int256 a, uint256 u, uint80 air) external {
        (roundId, answer, updatedAt, answeredInRound) = (r, a, u, air);
    }

    function setDecimals(uint8 d) external {
        decimals = d;
    }

    function setBand(int256 lo, int256 hi) external {
        (minAnswer, maxAnswer) = (lo, hi);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, answeredInRound);
    }
}
