// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";

/// @title HimalPrints
/// @notice A small NFT collection whose artist earns a royalty on every resale.
///         The royalty is announced with ERC-2981 (`royaltyInfo`), the standard way
///         marketplaces ask "who gets paid, and how much?".
/// @dev The deployer gets token IDs 1..`count`. No admin and no minting later.
contract HimalPrints is ERC721, ERC2981 {
    /// @param count       how many NFTs to mint to the deployer
    /// @param artist      who receives the royalty
    /// @param royaltyBps  royalty in basis points (500 = 5%)
    constructor(uint256 count, address artist, uint96 royaltyBps) ERC721("Himal Prints", "HPRT") {
        _setDefaultRoyalty(artist, royaltyBps);
        for (uint256 id = 1; id <= count; ++id) {
            _mint(msg.sender, id);
        }
    }

    /// @dev Both parents implement ERC-165; report both interfaces.
    function supportsInterface(bytes4 interfaceId) public view override(ERC721, ERC2981) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
