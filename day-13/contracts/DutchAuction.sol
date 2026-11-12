// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Public immutables keep readable getter names (nft(), seller(), ...) for the front end and tests.
// solhint-disable immutable-vars-naming

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title DutchAuction
/// @author Manish Khadka
/// @notice Sells one NFT at a price that falls every second, from `startPrice` down to
///         `floorPrice` over `duration`, then stays at the floor. The first buyer wins.
///         The buyer sends the most they are willing to pay; anything above the current
///         price is refunded in the same transaction, so a slow transaction can only make
///         the price lower, never higher.
/// @dev The seller's money is pulled with `withdraw()`, so a seller wallet that rejects
///      ETH cannot block a sale.
contract DutchAuction is ReentrancyGuard {
    uint256 public constant MIN_DURATION = 1 hours;
    uint256 public constant MAX_DURATION = 30 days;

    IERC721 public immutable nft;
    uint256 public immutable tokenId;
    address public immutable seller;
    uint256 public immutable startPrice;
    uint256 public immutable floorPrice;
    uint256 public immutable duration;

    /// @notice 0 until `start()` is called.
    uint256 public startAt;
    bool public closed;
    address public buyer;
    uint256 public soldPrice;
    /// @notice Sale proceeds waiting for the seller.
    uint256 public proceeds;

    event Started(uint256 startAt);
    event Sold(address indexed buyer, uint256 price);
    event Cancelled();
    event Withdrawn(uint256 amount);

    error ZeroAddress();
    error BadPrices();
    error BadDuration();
    error NotSeller();
    error AlreadyStarted();
    error NotStarted();
    error AuctionClosed();
    error SellerCannotBuy();
    error PriceStillFalling();
    error PriceAboveMax(uint256 price, uint256 sent);
    error NothingToWithdraw();
    error TransferFailed();

    modifier onlySeller() {
        if (msg.sender != seller) revert NotSeller();
        _;
    }

    /// @param startPrice_ Price at the first second, in wei.
    /// @param floorPrice_ Lowest price, reached at the end and kept after that. Can be 0.
    constructor(address nft_, uint256 tokenId_, uint256 startPrice_, uint256 floorPrice_, uint256 duration_) {
        if (nft_ == address(0)) revert ZeroAddress();
        if (startPrice_ <= floorPrice_) revert BadPrices();
        if (duration_ < MIN_DURATION || duration_ > MAX_DURATION) revert BadDuration();
        nft = IERC721(nft_);
        tokenId = tokenId_;
        seller = msg.sender;
        startPrice = startPrice_;
        floorPrice = floorPrice_;
        duration = duration_;
    }

    /// @notice Moves the NFT into the contract and starts the clock. Only once.
    function start() external onlySeller {
        if (startAt != 0) revert AlreadyStarted();
        startAt = block.timestamp;
        emit Started(block.timestamp);
        nft.transferFrom(seller, address(this), tokenId);
    }

    /// @notice The current price. Falls in a straight line, then stays at the floor.
    /// @dev The discount is rounded down, so the price is rounded up: never below the line,
    ///      and never below the floor.
    function currentPrice() public view returns (uint256) {
        // slither-disable-next-line incorrect-equality
        if (startAt == 0) return startPrice; // exact check on purpose: 0 means "not started"
        uint256 elapsed = block.timestamp - startAt;
        if (elapsed >= duration) return floorPrice;
        uint256 discount = ((startPrice - floorPrice) * elapsed) / duration;
        return startPrice - discount;
    }

    /// @notice Buy the NFT now. `msg.value` is your maximum; the change comes straight back.
    function buy() external payable nonReentrant {
        if (startAt == 0) revert NotStarted();
        if (closed) revert AuctionClosed();
        if (msg.sender == seller) revert SellerCannotBuy();
        uint256 price = currentPrice();
        if (msg.value < price) revert PriceAboveMax(price, msg.value);

        // Effects first.
        closed = true;
        buyer = msg.sender;
        soldPrice = price;
        proceeds = price;
        emit Sold(msg.sender, price);

        // Interactions last. `transferFrom` so a buyer contract cannot make the sale fail
        // half way through its own onERC721Received hook.
        nft.transferFrom(address(this), msg.sender, tokenId);
        uint256 change = msg.value - price;
        if (change > 0) {
            // slither-disable-next-line low-level-calls
            (bool ok, ) = payable(msg.sender).call{value: change}("");
            if (!ok) revert TransferFailed();
        }
    }

    /// @notice If nobody bought it by the end of the price drop, the seller can take the NFT back.
    /// @dev Not allowed while the price is still falling: otherwise the seller could watch the
    ///      waiting transactions and cancel just before a buyer's purchase at a price they now
    ///      dislike (front-running the buyer). The price curve is a promise.
    function cancel() external onlySeller {
        if (startAt == 0) revert NotStarted();
        if (closed) revert AuctionClosed();
        if (block.timestamp < startAt + duration) revert PriceStillFalling();
        closed = true;
        emit Cancelled();
        nft.transferFrom(address(this), seller, tokenId);
    }

    /// @notice The seller collects the sale price.
    function withdraw() external onlySeller nonReentrant {
        uint256 amount = proceeds;
        if (amount == 0) revert NothingToWithdraw();
        proceeds = 0;
        emit Withdrawn(amount);
        // slither-disable-next-line low-level-calls
        (bool ok, ) = payable(seller).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
