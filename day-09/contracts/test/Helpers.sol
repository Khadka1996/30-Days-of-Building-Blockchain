// solhint-disable
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Test-only contracts: never deployed for real.
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TokenVesting} from "../TokenVesting.sol";

/// @dev A plain token with a custom supply, to test the largest allowed amounts.
contract BigToken is ERC20 {
    constructor(uint256 supply) ERC20("Big", "BIG") {
        _mint(msg.sender, supply);
    }
}

/// @dev A token that calls the receiver during every transfer (like ERC-777 hooks).
contract HookToken is ERC20 {
    constructor() ERC20("Hook", "HOOK") {
        _mint(msg.sender, 1_000_000 ether);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (to.code.length > 0) {
            (bool ok, ) = to.call(abi.encodeWithSignature("onTokens()"));
            ok;
        }
    }
}

/// @dev A beneficiary that tries to claim a second time while being paid.
contract ReentrantBeneficiary {
    TokenVesting public vesting;
    uint256 public attempts;
    uint256 public successes;

    function attack(TokenVesting vesting_) external {
        vesting = vesting_;
        vesting_.release();
    }

    function onTokens() external {
        if (address(vesting) == address(0) || attempts > 0) return;
        attempts++;
        try vesting.release() {
            successes++;
        } catch {}
    }
}
