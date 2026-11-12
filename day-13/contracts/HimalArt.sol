// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @title HimalArt
/// @notice A tiny NFT collection used as the item for sale in today's auctions.
///         The deployer gets token IDs 1..`count`. Nothing else: no admin, no minting later.
contract HimalArt is ERC721 {
    constructor(uint256 count) ERC721("Himal Art", "HART") {
        for (uint256 id = 1; id <= count; ++id) {
            _mint(msg.sender, id);
        }
    }
}
