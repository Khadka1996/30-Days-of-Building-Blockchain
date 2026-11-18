// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {DollarEngine, IPriceFeed} from "../DollarEngine.sol";

/// @title NaiveDollarEngine — VULNERABLE ON PURPOSE, for the lesson only. Never deploy.
/// @notice Exactly the DollarEngine, except that it believes whatever number the feed returns:
///         no age check, no round check, no circuit-breaker band. The tests and demo use it to show
///         how a stale or clamped price lets people mint EUSD that is not really backed (a depeg).
contract NaiveDollarEngine is DollarEngine {
    constructor(IPriceFeed feed_, uint256 debtCeiling_) DollarEngine(feed_, debtCeiling_) {}

    function _price() internal view override returns (uint256) {
        (, int256 answer, , , ) = feed.latestRoundData();
        return uint256(answer) * 1e10; // trusts the feed blindly (and assumes 8 decimals)
    }
}
