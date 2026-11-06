// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Escrow — a buyer's money held safely until the item arrives
/// @author Manish Khadka
/// @notice A buyer opens a deal by paying ETH and naming a seller and a neutral
///         arbiter. The money then waits in the contract until one of these:
///           - the buyer confirms delivery          -> the seller is paid;
///           - the seller gives the money back      -> the buyer is refunded;
///           - either side raises a dispute         -> the arbiter decides;
///           - the buyer stays silent past the deadline -> the seller can claim;
///           - the arbiter stays silent for 30 days -> the buyer can take it back.
///         Every deal is a small state machine that only moves forward:
///             Funded -> Disputed -> Released | Refunded   (or Funded -> Released | Refunded)
///         Once a deal is Released or Refunded it can never move again.
/// @dev    Payouts are "pull payments": closing a deal only credits `owed[...]`,
///         and each person calls `withdraw()` for their own money. A seller or
///         buyer contract that refuses ETH can never block a deal from closing.
contract Escrow {
    enum State {
        None,     // no deal with this id
        Funded,   // buyer's money is held, waiting for delivery
        Disputed, // buyer or seller asked the arbiter to decide
        Released, // closed: the seller was paid
        Refunded  // closed: the buyer got the money back
    }

    struct Deal {
        address buyer;
        uint64 deadline;   // last moment the buyer can confirm or dispute; after it the seller can claim
        State state;
        address seller;
        uint64 disputedAt; // when the dispute started (0 if none)
        address arbiter;
        uint256 amount;    // wei held for this deal
    }

    uint256 public constant MIN_DURATION = 1 days;
    uint256 public constant MAX_DURATION = 180 days;  // money can never be locked for years
    uint256 public constant ARBITER_TIMEOUT = 30 days; // a silent arbiter cannot freeze money forever

    /// @notice Number of deals opened; ids are 0, 1, 2 …
    uint256 public dealCount;
    mapping(uint256 => Deal) private _deals;
    /// @notice ETH each address can withdraw from closed deals.
    mapping(address => uint256) public owed;

    bool private _locked;

    event DealOpened(uint256 indexed id, address indexed buyer, address indexed seller, address arbiter, uint256 amount, uint64 deadline);
    event Disputed(uint256 indexed id, address indexed by);
    event Released(uint256 indexed id, address indexed seller, uint256 amount, address indexed by);
    event Refunded(uint256 indexed id, address indexed buyer, uint256 amount, address indexed by);
    event Withdrawn(address indexed to, uint256 amount);

    error ZeroAmount();
    error ZeroAddress();
    error PartiesNotDistinct();
    error BadDuration();
    error UnknownDeal();
    error NotBuyer();
    error NotSeller();
    error NotArbiter();
    error NotParty();
    error WrongState(State current);
    error DeadlinePassed();
    error DeadlineNotPassed();
    error ArbiterStillHasTime();
    error NothingToWithdraw();
    error TransferFailed();
    error Reentrancy();
    error DirectPaymentRejected();

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    modifier exists(uint256 id) {
        if (id >= dealCount) revert UnknownDeal();
        _;
    }

    // ------------------------------------------------------------------ open

    /// @notice Buyer opens a deal by sending the payment. The buyer has `duration`
    ///         seconds to confirm delivery or raise a dispute.
    function openDeal(address seller, address arbiter, uint256 duration) external payable returns (uint256 id) {
        if (msg.value == 0) revert ZeroAmount();
        if (seller == address(0) || arbiter == address(0)) revert ZeroAddress();
        // The arbiter must be neutral: never the buyer or the seller.
        if (seller == msg.sender || arbiter == msg.sender || arbiter == seller) revert PartiesNotDistinct();
        if (duration < MIN_DURATION || duration > MAX_DURATION) revert BadDuration();

        id = dealCount++;
        uint64 deadline = uint64(block.timestamp + duration);
        _deals[id] = Deal({
            buyer: msg.sender,
            deadline: deadline,
            state: State.Funded,
            seller: seller,
            disputedAt: 0,
            arbiter: arbiter,
            amount: msg.value
        });
        emit DealOpened(id, msg.sender, seller, arbiter, msg.value, deadline);
    }

    // --------------------------------------------------------- happy paths

    /// @notice Buyer confirms the item arrived: the seller is paid.
    ///         Also allowed during a dispute (the buyer can always give in).
    function confirmDelivery(uint256 id) external exists(id) {
        Deal storage d = _deals[id];
        if (msg.sender != d.buyer) revert NotBuyer();
        _requireOpen(d);
        _release(id, d);
    }

    /// @notice Seller gives the money back to the buyer (e.g. out of stock).
    ///         Also allowed during a dispute (the seller can always give in).
    function refundBuyer(uint256 id) external exists(id) {
        Deal storage d = _deals[id];
        if (msg.sender != d.seller) revert NotSeller();
        _requireOpen(d);
        _refund(id, d);
    }

    // ------------------------------------------------------------ disputes

    /// @notice Buyer or seller asks the arbiter to decide. Only before the deadline,
    ///         so a seller's claim after the deadline can never be blocked by a late dispute.
    function dispute(uint256 id) external exists(id) {
        Deal storage d = _deals[id];
        if (msg.sender != d.buyer && msg.sender != d.seller) revert NotParty();
        if (d.state != State.Funded) revert WrongState(d.state);
        // solhint-disable-next-line not-rely-on-time
        if (block.timestamp >= d.deadline) revert DeadlinePassed();
        d.state = State.Disputed;
        d.disputedAt = uint64(block.timestamp);
        emit Disputed(id, msg.sender);
    }

    /// @notice The arbiter decides a dispute: pay the seller, or refund the buyer.
    ///         The arbiter can only act on a disputed deal and never receives the money.
    function resolve(uint256 id, bool paySeller) external exists(id) {
        Deal storage d = _deals[id];
        if (msg.sender != d.arbiter) revert NotArbiter();
        if (d.state != State.Disputed) revert WrongState(d.state);
        if (paySeller) _release(id, d);
        else _refund(id, d);
    }

    // ------------------------------------------------- timeouts (no stuck funds)

    /// @notice The buyer stayed silent until the deadline: the seller can take the payment.
    function claimAfterDeadline(uint256 id) external exists(id) {
        Deal storage d = _deals[id];
        if (msg.sender != d.seller) revert NotSeller();
        if (d.state != State.Funded) revert WrongState(d.state);
        // solhint-disable-next-line not-rely-on-time
        if (block.timestamp < d.deadline) revert DeadlineNotPassed();
        _release(id, d);
    }

    /// @notice The arbiter stayed silent for ARBITER_TIMEOUT after a dispute:
    ///         the money goes back to the buyer, who paid it. Buyer or seller can trigger this.
    function refundAfterArbiterTimeout(uint256 id) external exists(id) {
        Deal storage d = _deals[id];
        if (msg.sender != d.buyer && msg.sender != d.seller) revert NotParty();
        if (d.state != State.Disputed) revert WrongState(d.state);
        // solhint-disable-next-line not-rely-on-time
        if (block.timestamp < uint256(d.disputedAt) + ARBITER_TIMEOUT) revert ArbiterStillHasTime();
        _refund(id, d);
    }

    // ------------------------------------------------------------ withdraw

    /// @notice Take out the ETH you are owed from closed deals.
    function withdraw() external nonReentrant {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        // Effects before the interaction: zero first, so it can never pay twice.
        owed[msg.sender] = 0;
        emit Withdrawn(msg.sender, amount);
        // `call` forwards all gas so smart-contract wallets can receive.
        // slither-disable-next-line low-level-calls
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // --------------------------------------------------------------- views

    /// @notice Read a deal.
    function getDeal(uint256 id) external view exists(id) returns (Deal memory) {
        return _deals[id];
    }

    /// @dev Plain ETH sent to the contract belongs to no deal, so it is refused.
    receive() external payable {
        revert DirectPaymentRejected();
    }

    // ------------------------------------------------------------ internal

    function _requireOpen(Deal storage d) private view {
        if (d.state != State.Funded && d.state != State.Disputed) revert WrongState(d.state);
    }

    /// @dev Close the deal in the seller's favour. The state changes first, so it can only happen once.
    function _release(uint256 id, Deal storage d) private {
        d.state = State.Released;
        owed[d.seller] += d.amount;
        emit Released(id, d.seller, d.amount, msg.sender);
    }

    /// @dev Close the deal in the buyer's favour. The state changes first, so it can only happen once.
    function _refund(uint256 id, Deal storage d) private {
        d.state = State.Refunded;
        owed[d.buyer] += d.amount;
        emit Refunded(id, d.buyer, d.amount, msg.sender);
    }
}
