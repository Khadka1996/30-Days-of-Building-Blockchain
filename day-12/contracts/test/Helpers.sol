// SPDX-License-Identifier: MIT
// solhint-disable one-contract-per-file, no-empty-blocks, use-forbidden-name, avoid-low-level-calls, no-complex-fallback
pragma solidity 0.8.24;

// Test-only contracts: hostile NFTs, hostile wallets and a naive marketplace to show the attack.

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

interface IMarket {
    function buy(address nft, uint256 tokenId, uint256 expectedPrice) external payable;
    function withdraw() external;
    function list(address nft, uint256 tokenId, uint256 price, uint256 duration) external;
}

/// @dev An ERC-721 + ERC-2981 whose royalty can be set to anything, even more than the price.
contract GreedyNFT is ERC721 {
    address public receiver;
    uint256 public bps;
    bool public revertRoyalty;

    constructor(address r, uint256 b) ERC721("Greedy", "GRDY") {
        receiver = r;
        bps = b;
        _mint(msg.sender, 1);
        _mint(msg.sender, 2);
    }

    function setRoyalty(address r, uint256 b, bool rev) external {
        receiver = r;
        bps = b;
        revertRoyalty = rev;
    }

    function burn(uint256 id) external {
        _burn(id);
    }

    function royaltyInfo(uint256, uint256 price) external view returns (address, uint256) {
        require(!revertRoyalty, "royalty broken");
        return (receiver, (price * bps) / 10_000);
    }

    function supportsInterface(bytes4 id) public view override returns (bool) {
        return id == 0x2a55205a || super.supportsInterface(id); // 0x2a55205a = IERC2981
    }
}

/// @dev A plain ERC-721 with no royalty support at all.
contract PlainNFT is ERC721 {
    constructor() ERC721("Plain", "PLN") {
        _mint(msg.sender, 1);
    }
}

/// @dev A wallet that refuses ETH (e.g. a broken creator or seller contract).
contract RejectingWallet {
    function withdrawFrom(IMarket m) external {
        m.withdraw();
    }

    function approveAndList(IMarket m, IERC721 nft, uint256 id, uint256 price) external {
        nft.approve(address(m), id);
        m.list(address(nft), id, price, 1 days);
    }

    receive() external payable {
        revert("no ETH please");
    }
}

/// @dev Calls back into the market while it is being paid.
contract ReentrantWallet {
    IMarket public market;
    address public nft;
    uint256 public tokenId;
    uint256 public price;
    uint8 public mode; // 1 = withdraw again, 2 = buy during withdraw
    bool public reentryBlocked;

    constructor(IMarket m) {
        market = m;
    }

    function setTarget(address n, uint256 id, uint256 p, uint8 md) external {
        nft = n;
        tokenId = id;
        price = p;
        mode = md;
    }

    function approveAndList(IERC721 n, uint256 id, uint256 p) external {
        n.approve(address(market), id);
        market.list(address(n), id, p, 1 days);
    }

    function doWithdraw() external {
        market.withdraw();
    }

    receive() external payable {
        if (mode == 1) {
            mode = 0;
            try market.withdraw() {} catch { reentryBlocked = true; }
        } else if (mode == 2) {
            mode = 0;
            try market.buy{value: price}(nft, tokenId, price) {} catch { reentryBlocked = true; }
        }
    }
}

/// @dev A buyer contract with no onERC721Received (cannot take safe transfers).
contract PlainBuyer {
    function buy(IMarket m, address nft, uint256 id, uint256 p) external payable {
        m.buy{value: p}(nft, id, p);
    }
}

/// @dev The naive design: at sale time it moves the NFT from WHOEVER owns it now,
///      but pays whoever listed it. A stale listing then sells someone else's NFT.
contract NaiveMarket {
    struct Listing {
        address seller;
        uint256 price;
    }

    mapping(address => mapping(uint256 => Listing)) public listings;

    function list(address nft, uint256 id, uint256 price) external {
        require(IERC721(nft).ownerOf(id) == msg.sender, "not owner");
        listings[nft][id] = Listing(msg.sender, price);
    }

    function buy(address nft, uint256 id) external payable {
        Listing memory l = listings[nft][id];
        require(l.seller != address(0) && msg.value == l.price, "bad");
        delete listings[nft][id];
        address owner = IERC721(nft).ownerOf(id);
        IERC721(nft).transferFrom(owner, msg.sender, id);
        (bool ok,) = l.seller.call{value: msg.value}("");
        require(ok, "pay");
    }
}
