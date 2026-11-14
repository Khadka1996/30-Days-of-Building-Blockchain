// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title HimalMarket
/// @notice A simple NFT marketplace. Sellers list an NFT at a fixed price, buyers pay
///         exactly that price, and the NFT's creator automatically gets a royalty (ERC-2981).
///
///         The NFT never leaves the seller's wallet while it is listed. The seller only
///         gives the market permission (`approve`) to move it. So at the moment of sale the
///         market re-checks that the seller STILL owns it: a listing for an NFT that was sold
///         or given away elsewhere can never be bought.
///
///         Money is never pushed during a sale. The seller's and the creator's shares are
///         written down in `proceeds` and each collects their own with `withdraw()`.
contract HimalMarket is ReentrancyGuard {
    struct Listing {
        address seller;
        uint96 expiresAt; // listing stops working after this time
        uint256 price; // in wei
    }

    /// @notice Royalties above 10% are cut down to 10%, so a collection cannot take the whole price.
    uint256 public constant MAX_ROYALTY_BPS = 1_000;
    /// @notice A listing can run for at most 180 days.
    uint256 public constant MAX_DURATION = 180 days;
    uint256 private constant BPS = 10_000;

    /// @notice nft contract => token id => listing
    mapping(address => mapping(uint256 => Listing)) public listings;
    /// @notice money waiting to be withdrawn by sellers and creators
    mapping(address => uint256) public proceeds;

    event Listed(address indexed nft, uint256 indexed tokenId, address indexed seller, uint256 price, uint256 expiresAt);
    event PriceUpdated(address indexed nft, uint256 indexed tokenId, uint256 oldPrice, uint256 newPrice);
    event Cancelled(address indexed nft, uint256 indexed tokenId, address indexed by);
    event Sold(
        address indexed nft,
        uint256 indexed tokenId,
        address indexed buyer,
        address seller,
        uint256 price,
        address royaltyReceiver,
        uint256 royalty
    );
    event Withdrawn(address indexed account, uint256 amount);

    error PriceZero();
    error BadDuration();
    error NotOwner();
    error NotApproved();
    error NotListed();
    error NotSeller();
    error ListingExpired();
    error StaleListing();
    error PriceChanged(uint256 current);
    error WrongPayment(uint256 required);
    error SellerCannotBuy();
    error StillValid();
    error NothingToWithdraw();
    error TransferFailed();

    // ------------------------------------------------------------------ selling

    /// @notice List an NFT you own. First call `nft.approve(market, tokenId)` or `setApprovalForAll`.
    /// @param duration how long the listing stays open, in seconds (1 hour to 180 days)
    function list(address nft, uint256 tokenId, uint256 price, uint256 duration) external {
        if (price == 0) revert PriceZero();
        if (duration < 1 hours || duration > MAX_DURATION) revert BadDuration();
        if (IERC721(nft).ownerOf(tokenId) != msg.sender) revert NotOwner();
        if (!_marketApproved(nft, tokenId, msg.sender)) revert NotApproved();

        uint96 expiresAt = uint96(block.timestamp + duration);
        // A new owner's listing simply replaces an old one left behind by a previous owner.
        listings[nft][tokenId] = Listing({seller: msg.sender, expiresAt: expiresAt, price: price});
        emit Listed(nft, tokenId, msg.sender, price, expiresAt);
    }

    /// @notice Change the price of your own listing.
    function updatePrice(address nft, uint256 tokenId, uint256 newPrice) external {
        Listing storage item = listings[nft][tokenId];
        if (item.seller == address(0)) revert NotListed();
        if (item.seller != msg.sender) revert NotSeller();
        if (newPrice == 0) revert PriceZero();
        if (IERC721(nft).ownerOf(tokenId) != msg.sender) revert NotOwner();
        uint256 old = item.price;
        item.price = newPrice;
        emit PriceUpdated(nft, tokenId, old, newPrice);
    }

    /// @notice The seller can always cancel. Anyone else can remove a listing only when it can
    ///         no longer be bought (expired, the seller no longer owns the NFT, or approval was taken away).
    function cancel(address nft, uint256 tokenId) external {
        Listing memory item = listings[nft][tokenId];
        if (item.seller == address(0)) revert NotListed();
        if (msg.sender != item.seller && _isBuyable(nft, tokenId, item)) revert StillValid();
        delete listings[nft][tokenId];
        emit Cancelled(nft, tokenId, msg.sender);
    }

    // ------------------------------------------------------------------ buying

    /// @notice Buy a listed NFT. Send exactly the price.
    /// @param expectedPrice the price you saw. If the seller changes it while your
    ///        transaction is waiting, the purchase fails instead of charging you more.
    function buy(address nft, uint256 tokenId, uint256 expectedPrice) external payable nonReentrant {
        Listing memory item = listings[nft][tokenId];
        if (item.seller == address(0)) revert NotListed();
        if (item.price != expectedPrice) revert PriceChanged(item.price);
        if (msg.value != item.price) revert WrongPayment(item.price);
        if (msg.sender == item.seller) revert SellerCannotBuy();
        // slither-disable-next-line timestamp
        if (block.timestamp > item.expiresAt) revert ListingExpired();
        if (IERC721(nft).ownerOf(tokenId) != item.seller) revert StaleListing();
        if (!_marketApproved(nft, tokenId, item.seller)) revert NotApproved();

        // Effects first: the listing is gone before anything external happens.
        delete listings[nft][tokenId];

        (address receiver, uint256 royalty) = _royalty(nft, tokenId, item.price);
        proceeds[item.seller] += item.price - royalty;
        if (royalty > 0) proceeds[receiver] += royalty;

        emit Sold(nft, tokenId, msg.sender, item.seller, item.price, receiver, royalty);

        // The seller listed this NFT and approved the market, and we just checked they still own it.
        // transferFrom (not safeTransferFrom): the buyer chose to buy, and a buyer contract
        // without onERC721Received must not be able to make the sale revert in strange ways.
        // slither-disable-next-line arbitrary-send-erc20
        IERC721(nft).transferFrom(item.seller, msg.sender, tokenId);
    }

    /// @notice Collect your share of sales (sellers) or royalties (creators).
    function withdraw() external nonReentrant {
        uint256 amount = proceeds[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        proceeds[msg.sender] = 0;
        emit Withdrawn(msg.sender, amount);
        // slither-disable-next-line low-level-calls
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ------------------------------------------------------------------ views

    /// @notice True if this listing could be bought right now.
    function isBuyable(address nft, uint256 tokenId) external view returns (bool) {
        Listing memory item = listings[nft][tokenId];
        return item.seller != address(0) && _isBuyable(nft, tokenId, item);
    }

    /// @notice How a price would be split between the creator and the seller.
    function quote(address nft, uint256 tokenId, uint256 price)
        external
        view
        returns (address royaltyReceiver, uint256 royalty, uint256 sellerGets)
    {
        (royaltyReceiver, royalty) = _royalty(nft, tokenId, price);
        sellerGets = price - royalty;
    }

    // ------------------------------------------------------------------ internal

    function _isBuyable(address nft, uint256 tokenId, Listing memory item) private view returns (bool) {
        // slither-disable-next-line timestamp
        if (block.timestamp > item.expiresAt) return false;
        try IERC721(nft).ownerOf(tokenId) returns (address owner) {
            if (owner != item.seller) return false;
        } catch {
            return false; // the NFT was burned
        }
        return _marketApproved(nft, tokenId, item.seller);
    }

    function _marketApproved(address nft, uint256 tokenId, address owner) private view returns (bool) {
        return IERC721(nft).getApproved(tokenId) == address(this)
            || IERC721(nft).isApprovedForAll(owner, address(this));
    }

    /// @dev Reads ERC-2981 if the NFT supports it. Never trusts the answer blindly:
    ///      a missing receiver means no royalty, and anything above 10% is cut to 10%.
    function _royalty(address nft, uint256 tokenId, uint256 price)
        private
        view
        returns (address receiver, uint256 royalty)
    {
        try IERC165(nft).supportsInterface(type(IERC2981).interfaceId) returns (bool yes) {
            if (!yes) return (address(0), 0);
        } catch {
            return (address(0), 0);
        }
        try IERC2981(nft).royaltyInfo(tokenId, price) returns (address r, uint256 amount) {
            if (r == address(0) || amount == 0) return (address(0), 0);
            uint256 cap = (price * MAX_ROYALTY_BPS) / BPS;
            return (r, amount > cap ? cap : amount);
        } catch {
            return (address(0), 0);
        }
    }
}
