// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev TEST ONLY. A tiny constant-product (x × y = k) swap pool for HIM/HUSD, like a one-pair
///      Uniswap V2 with a 0.3% fee. Its "spot price" is just reserveHUSD / reserveHIM, so a single
///      big trade moves it. Day 17 builds a proper swap pool and router.
contract MiniPair {
    // solhint-disable-next-line immutable-vars-naming
    IERC20 public immutable him;
    // solhint-disable-next-line immutable-vars-naming
    IERC20 public immutable husd;
    uint256 public reserveHim;
    uint256 public reserveHusd;

    constructor(IERC20 him_, IERC20 husd_) {
        him = him_;
        husd = husd_;
    }

    function addLiquidity(uint256 himAmount, uint256 husdAmount) external {
        him.transferFrom(msg.sender, address(this), himAmount);
        husd.transferFrom(msg.sender, address(this), husdAmount);
        reserveHim += himAmount;
        reserveHusd += husdAmount;
    }

    /// @notice Spot price of 1 HIM in HUSD, 8 decimals (same scale as the price feed).
    function spotPrice() external view returns (uint256) {
        return (reserveHusd * 1e8) / reserveHim;
    }

    function swap(IERC20 tokenIn, uint256 amountIn) external returns (uint256 out) {
        bool himIn = address(tokenIn) == address(him);
        require(himIn || address(tokenIn) == address(husd), "bad token");
        (uint256 rIn, uint256 rOut) = himIn ? (reserveHim, reserveHusd) : (reserveHusd, reserveHim);
        uint256 inWithFee = amountIn * 997;
        out = (inWithFee * rOut) / (rIn * 1000 + inWithFee);
        if (himIn) {
            reserveHim += amountIn;
            reserveHusd -= out;
        } else {
            reserveHusd += amountIn;
            reserveHim -= out;
        }
        tokenIn.transferFrom(msg.sender, address(this), amountIn);
        (himIn ? husd : him).transfer(msg.sender, out);
    }
}
