// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Public immutables keep readable getter names (nft(), seller(), ...) for the front end and tests.
// solhint-disable immutable-vars-naming

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title EnglishAuction
/// @author Manish Khadka
/// @notice Sells one NFT to the highest bidder. Bids only go up: each new bid must beat the
///         current one by at least 5%. A bid in the last 10 minutes pushes the end back to
///         10 minutes from that bid, so nobody can "snipe" the auction in the final second.
/// @dev Refunds use the pull pattern: an outbid bidder's ETH is recorded in `pendingReturns`
///      and they call `withdraw()` themselves. A bidder whose wallet rejects ETH can therefore
///      never block new bids or the end of the auction (refund denial-of-service).
contract EnglishAuction is ReentrancyGuard {
    // ----------------------------------------------------------------------------------
    // Settings (fixed at deploy time)
    // ----------------------------------------------------------------------------------

    /// @notice Every new bid must be at least this much higher, in basis points (500 = 5%).
    uint256 public constant MIN_INCREMENT_BPS = 500;
    /// @notice A bid placed this close to the end extends the auction to `now + EXTENSION`.
    uint256 public constant EXTENSION = 10 minutes;
    uint256 public constant MIN_DURATION = 1 hours;
    uint256 public constant MAX_DURATION = 30 days;

    IERC721 public immutable nft;
    uint256 public immutable tokenId;
    address public immutable seller;
    /// @notice The first bid must be at least this much.
    uint256 public immutable reservePrice;
    uint256 public immutable duration;

    // ----------------------------------------------------------------------------------
    // State
    // ----------------------------------------------------------------------------------

    /// @notice 0 until `start()` is called.
    uint256 public endAt;
    bool public ended;
    address public highestBidder;
    uint256 public highestBid;
    /// @notice ETH each address can take back: outbid bids, and the seller's proceeds.
    mapping(address => uint256) public pendingReturns;

    // ----------------------------------------------------------------------------------
    // Events and errors
    // ----------------------------------------------------------------------------------

    event Started(uint256 endAt);
    event BidPlaced(address indexed bidder, uint256 amount, uint256 endAt);
    event Extended(uint256 newEndAt);
    event Withdrawn(address indexed account, uint256 amount);
    event Ended(address indexed winner, uint256 amount);
    event Cancelled();

    error ZeroAddress();
    error ZeroReserve();
    error BadDuration();
    error NotSeller();
    error AlreadyStarted();
    error NotStarted();
    error AuctionClosed();
    error AuctionStillRunning();
    error SellerCannotBid();
    error BidTooLow(uint256 minimum);
    error HasBids();
    error NothingToWithdraw();
    error TransferFailed();

    modifier onlySeller() {
        if (msg.sender != seller) revert NotSeller();
        _;
    }

    /// @param nft_ The NFT contract.
    /// @param tokenId_ The token being sold. The seller must own it and approve this contract.
    /// @param reservePrice_ The lowest acceptable first bid, in wei.
    /// @param duration_ How long bidding is open after `start()`, before any extensions.
    constructor(address nft_, uint256 tokenId_, uint256 reservePrice_, uint256 duration_) {
        if (nft_ == address(0)) revert ZeroAddress();
        if (reservePrice_ == 0) revert ZeroReserve();
        if (duration_ < MIN_DURATION || duration_ > MAX_DURATION) revert BadDuration();
        nft = IERC721(nft_);
        tokenId = tokenId_;
        seller = msg.sender;
        reservePrice = reservePrice_;
        duration = duration_;
    }

    // ----------------------------------------------------------------------------------
    // Seller actions
    // ----------------------------------------------------------------------------------

    /// @notice Moves the NFT into the contract and opens bidding. Can only happen once.
    function start() external onlySeller {
        if (endAt != 0) revert AlreadyStarted();
        uint256 closesAt = block.timestamp + duration;
        endAt = closesAt;
        emit Started(closesAt);
        nft.transferFrom(seller, address(this), tokenId);
    }

    /// @notice The seller may stop the auction only while nobody has bid. The NFT goes back.
    function cancel() external onlySeller {
        if (endAt == 0) revert NotStarted();
        if (ended) revert AuctionClosed();
        if (highestBidder != address(0)) revert HasBids();
        ended = true;
        emit Cancelled();
        nft.transferFrom(address(this), seller, tokenId);
    }

    // ----------------------------------------------------------------------------------
    // Bidding
    // ----------------------------------------------------------------------------------

    /// @notice The smallest amount that would be accepted as the next bid.
    function minNextBid() public view returns (uint256) {
        if (highestBidder == address(0)) return reservePrice;
        // Round up so the increment is never less than 5%, and always at least 1 wei.
        uint256 step = (highestBid * MIN_INCREMENT_BPS + 9_999) / 10_000;
        return highestBid + step;
    }

    /// @notice Place a bid. Send the full bid amount as ETH.
    ///         If you are outbid, your ETH waits for you in `pendingReturns`.
    function bid() external payable {
        uint256 closesAt = endAt;
        // slither-disable-next-line incorrect-equality
        if (closesAt == 0) revert NotStarted(); // exact check on purpose: 0 means "not started"
        if (ended || block.timestamp >= closesAt) revert AuctionClosed();
        if (msg.sender == seller) revert SellerCannotBid();
        uint256 minimum = minNextBid();
        if (msg.value < minimum) revert BidTooLow(minimum);

        // Effects only: the previous leader is credited, not paid, so nothing here can fail
        // because of someone else's wallet.
        address previous = highestBidder;
        if (previous != address(0)) {
            pendingReturns[previous] += highestBid;
        }
        highestBidder = msg.sender;
        highestBid = msg.value;

        // Anti-sniping: a late bid gives everyone else 10 more minutes to answer.
        if (closesAt - block.timestamp < EXTENSION) {
            closesAt = block.timestamp + EXTENSION;
            endAt = closesAt;
            emit Extended(closesAt);
        }
        emit BidPlaced(msg.sender, msg.value, closesAt);
    }

    /// @notice Take back your outbid ETH (or, for the seller, the sale proceeds).
    function withdraw() external nonReentrant {
        uint256 amount = pendingReturns[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        pendingReturns[msg.sender] = 0; // effect before the external call
        emit Withdrawn(msg.sender, amount);
        // A plain call forwards enough gas for smart-contract wallets; the result is checked.
        // slither-disable-next-line low-level-calls
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ----------------------------------------------------------------------------------
    // Ending
    // ----------------------------------------------------------------------------------

    /// @notice After the end time, anyone can settle: the NFT goes to the winner and the
    ///         winning bid is credited to the seller. With no bids, the NFT goes back.
    /// @dev Uses `transferFrom`, not `safeTransferFrom`: a winner contract that reverts in
    ///      `onERC721Received` must not be able to lock the seller's money for ever.
    function end() external {
        // slither-disable-next-line incorrect-equality
        if (endAt == 0) revert NotStarted(); // exact check on purpose: 0 means "not started"
        if (ended) revert AuctionClosed();
        if (block.timestamp < endAt) revert AuctionStillRunning();
        ended = true;

        address winner = highestBidder;
        if (winner == address(0)) {
            emit Ended(address(0), 0);
            nft.transferFrom(address(this), seller, tokenId);
        } else {
            uint256 amount = highestBid;
            pendingReturns[seller] += amount;
            emit Ended(winner, amount);
            nft.transferFrom(address(this), winner, tokenId);
        }
    }
}
