// SPDX-License-Identifier: MIT
// solhint-disable one-contract-per-file
pragma solidity 0.8.24;

// Test-only helper contracts. They are never deployed outside the tests.
// solhint-disable one-contract-per-file, immutable-vars-naming, no-empty-blocks

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

interface IHimalPeaks {
    function publicMint(uint256 quantity) external payable;
    function allowlistMint(uint256 quantity, bytes32[] calldata proof) external payable;
    function publicPrice() external view returns (uint256);
}

/// @dev A "bot" wallet contract that tries to mint again from inside onERC721Received,
///      to get past the per-wallet limit or the max supply.
contract ReentrantMinter is IERC721Receiver {
    IHimalPeaks public immutable target;
    bool public tryAgain;
    bool public reentryBlocked;

    constructor(IHimalPeaks target_) {
        target = target_;
    }

    function attack(uint256 quantity) external payable {
        tryAgain = true;
        target.publicMint{value: msg.value}(quantity);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        if (tryAgain) {
            tryAgain = false;
            uint256 price = target.publicPrice();
            try target.publicMint{value: price}(1) {} catch {
                reentryBlocked = true;
            }
        }
        return IERC721Receiver.onERC721Received.selector;
    }

    receive() external payable {}
}

/// @dev A contract that cannot receive NFTs (no onERC721Received). Minting to it must fail.
contract NoReceiver {
    function mint(IHimalPeaks target, uint256 quantity) external payable {
        target.publicMint{value: msg.value}(quantity);
    }
}

/// @dev A treasury that refuses ETH, to prove withdraw() fails loudly and keeps the money safe.
contract RejectingTreasury {
    receive() external payable {
        revert("no thanks");
    }
}
