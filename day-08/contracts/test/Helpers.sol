// SPDX-License-Identifier: MIT
// solhint-disable one-contract-per-file, avoid-low-level-calls
pragma solidity 0.8.24;

// Test-only helper contracts. Not part of the faucet.

interface IFaucet {
    function claim() external;
}

/// @notice One throw-away address: claims from the faucet and forwards the tokens to its boss.
contract Minion {
    constructor(IFaucet faucet, address token, address boss) {
        faucet.claim();
        (bool ok, bytes memory data) = token.call(abi.encodeWithSignature("balanceOf(address)", address(this)));
        require(ok, "balanceOf");
        uint256 bal = abi.decode(data, (uint256));
        (ok, ) = token.call(abi.encodeWithSignature("transfer(address,uint256)", boss, bal));
        require(ok, "transfer");
    }
}

/// @notice The "many addresses" attack in one transaction: deploy N brand-new contracts,
///         each a new address that has never claimed, and let each one claim once.
contract SybilAttacker {
    uint256 public successes;
    uint256 public failures;

    function attack(IFaucet faucet, address token, uint256 count) external {
        for (uint256 i = 0; i < count; ++i) {
            try new Minion(faucet, token, msg.sender) {
                ++successes;
            } catch {
                ++failures;
            }
        }
    }
}

/// @notice A contract that claims and then tries to claim again in the same transaction.
contract DoubleClaimer {
    function claimTwice(IFaucet faucet) external {
        faucet.claim();
        faucet.claim();
    }
}
