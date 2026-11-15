// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MiniPair} from "./MiniPair.sol";

/// @dev TEST ONLY. A deliberately broken lending pool: it values collateral at the swap pool's
///      SPOT price. Anyone who can move that price for one transaction can borrow far more than
///      the collateral is really worth. Used to prove why HimalLend uses a price feed instead.
contract NaiveSpotLending {
    // solhint-disable-next-line immutable-vars-naming
    IERC20 public immutable husd;
    // solhint-disable-next-line immutable-vars-naming
    IERC20 public immutable him;
    // solhint-disable-next-line immutable-vars-naming
    MiniPair public immutable pair;
    mapping(address => uint256) public collateralOf;
    mapping(address => uint256) public debtOf;

    constructor(IERC20 husd_, IERC20 him_, MiniPair pair_) {
        husd = husd_;
        him = him_;
        pair = pair_;
    }

    function fund(uint256 amount) external {
        husd.transferFrom(msg.sender, address(this), amount);
    }

    function depositCollateral(uint256 amount) external {
        him.transferFrom(msg.sender, address(this), amount);
        collateralOf[msg.sender] += amount;
    }

    function borrow(uint256 amount) external {
        uint256 value = (collateralOf[msg.sender] * pair.spotPrice()) / 1e8; // BUG: spot price
        require((debtOf[msg.sender] + amount) * 100 <= value * 75, "over 75% LTV");
        debtOf[msg.sender] += amount;
        husd.transfer(msg.sender, amount);
    }
}
