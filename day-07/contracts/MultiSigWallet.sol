// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title MultiSigWallet — a shared wallet where every payment needs M of N owner approvals
/// @author Manish Khadka
/// @notice Owners propose a transaction (where to send ETH and/or what to call),
///         other owners approve it, and once enough owners have approved, any
///         owner can execute it. Each proposal can run at most ONCE.
///         Owners and the threshold can only be changed by the wallet itself,
///         which means through a proposal that the owners approved.
/// @dev    Any change to the owners or the threshold bumps `configVersion`.
///         Proposals remember the version they were created under and become
///         stale when it changes, so approvals from a removed owner (or made
///         under an old threshold) can never be used to move money.
contract MultiSigWallet {
    struct Transaction {
        address to;
        uint96 configVersion;  // owner/threshold version this proposal belongs to
        uint256 value;         // wei to send
        bytes data;            // calldata (empty for a plain ETH payment)
        bool executed;
        uint32 approvals;      // number of current owners who approved
    }

    uint256 public constant MAX_OWNERS = 10;  // keeps owner loops small and cheap

    address[] private _owners;
    mapping(address => bool) public isOwner;
    /// @notice Approvals needed to execute a proposal.
    uint256 public threshold;
    /// @notice Bumped on every owner or threshold change; older proposals become stale.
    uint96 public configVersion;

    Transaction[] private _transactions;
    mapping(uint256 => mapping(address => bool)) public approved;

    uint256 private _lock = 1; // reentrancy lock for execute(): 1 = free, 2 = busy

    event Deposit(address indexed from, uint256 amount, uint256 balance);
    event Submitted(uint256 indexed txId, address indexed owner, address indexed to, uint256 value, bytes data);
    event Approved(uint256 indexed txId, address indexed owner);
    event Revoked(uint256 indexed txId, address indexed owner);
    event Executed(uint256 indexed txId, address indexed owner);
    event OwnerAdded(address indexed owner);
    event OwnerRemoved(address indexed owner);
    event ThresholdChanged(uint256 threshold);

    error NotOwner(address caller);
    error OnlyWallet();
    error BadOwnerCount(uint256 count);
    error BadThreshold(uint256 threshold, uint256 ownerCount);
    error InvalidOwner(address owner);
    error DuplicateOwner(address owner);
    error TxNotFound(uint256 txId);
    error AlreadyExecuted(uint256 txId);
    error StaleTransaction(uint256 txId);
    error AlreadyApproved(uint256 txId, address owner);
    error NotApproved(uint256 txId, address owner);
    error NotEnoughApprovals(uint256 txId, uint256 approvals, uint256 needed);
    error ExecutionFailed(uint256 txId, bytes reason);
    error Reentrancy();
    error ZeroTarget();

    /// @dev Blocks running a second proposal from inside the call of the first one.
    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    modifier onlyOwner() {
        if (!isOwner[msg.sender]) revert NotOwner(msg.sender);
        _;
    }

    /// @dev Owner and threshold changes must come from an approved, executed proposal.
    modifier onlyWallet() {
        if (msg.sender != address(this)) revert OnlyWallet();
        _;
    }

    /// @dev The proposal exists, has not run yet and belongs to the current owner set.
    modifier pending(uint256 txId) {
        if (txId >= _transactions.length) revert TxNotFound(txId);
        Transaction storage t = _transactions[txId];
        if (t.executed) revert AlreadyExecuted(txId);
        if (t.configVersion != configVersion) revert StaleTransaction(txId);
        _;
    }

    /// @param owners_    1 to 10 distinct, non-zero addresses
    /// @param threshold_ approvals needed, from 1 to owners_.length
    constructor(address[] memory owners_, uint256 threshold_) payable {
        uint256 count = owners_.length;
        if (count == 0 || count > MAX_OWNERS) revert BadOwnerCount(count);
        if (threshold_ == 0 || threshold_ > count) revert BadThreshold(threshold_, count);
        for (uint256 i = 0; i < count; ++i) {
            _addOwner(owners_[i]);
        }
        threshold = threshold_;
        emit ThresholdChanged(threshold_);
    }

    /// @notice Anyone can send ETH to the wallet.
    receive() external payable {
        emit Deposit(msg.sender, msg.value, address(this).balance);
    }

    // ---------------------------------------------------------------------
    // Proposals
    // ---------------------------------------------------------------------

    /// @notice Propose a payment or a contract call. The proposer still has to approve it.
    /// @return txId the id of the new proposal (0, 1, 2…)
    function submit(address to, uint256 value, bytes calldata data) external onlyOwner returns (uint256 txId) {
        if (to == address(0)) revert ZeroTarget();
        txId = _transactions.length;
        _transactions.push(Transaction({
            to: to,
            configVersion: configVersion,
            value: value,
            data: data,
            executed: false,
            approvals: 0
        }));
        emit Submitted(txId, msg.sender, to, value, data);
    }

    /// @notice Approve a pending proposal. Each owner can approve once.
    function approve(uint256 txId) external onlyOwner pending(txId) {
        if (approved[txId][msg.sender]) revert AlreadyApproved(txId, msg.sender);
        approved[txId][msg.sender] = true;
        _transactions[txId].approvals += 1;
        emit Approved(txId, msg.sender);
    }

    /// @notice Take back your approval before the proposal runs.
    function revoke(uint256 txId) external onlyOwner pending(txId) {
        if (!approved[txId][msg.sender]) revert NotApproved(txId, msg.sender);
        approved[txId][msg.sender] = false;
        _transactions[txId].approvals -= 1;
        emit Revoked(txId, msg.sender);
    }

    /// @notice Run a proposal that has enough approvals. It can only ever run once.
    /// @dev Checks → effects (executed = true) → interaction (the external call).
    ///      If the call fails, the whole execute reverts and the proposal stays pending.
    function execute(uint256 txId) external onlyOwner pending(txId) nonReentrant {
        Transaction storage t = _transactions[txId];
        if (t.approvals < threshold) revert NotEnoughApprovals(txId, t.approvals, threshold);

        t.executed = true;      // effect first: replaying this id is now impossible
        emit Executed(txId, msg.sender); // rolled back too if the call below fails

        // slither-disable-next-line arbitrary-send-eth,low-level-calls
        (bool ok, bytes memory reason) = t.to.call{value: t.value}(t.data);
        if (!ok) revert ExecutionFailed(txId, reason);
    }

    // ---------------------------------------------------------------------
    // Owner management (only through an executed proposal)
    // ---------------------------------------------------------------------

    /// @notice Add a new owner. Call this through a proposal.
    function addOwner(address owner) external onlyWallet {
        if (_owners.length >= MAX_OWNERS) revert BadOwnerCount(_owners.length + 1);
        _addOwner(owner);
        _bumpVersion();
    }

    /// @notice Remove an owner. Fails if fewer owners than the threshold would remain.
    function removeOwner(address owner) external onlyWallet {
        if (!isOwner[owner]) revert InvalidOwner(owner);
        uint256 count = _owners.length;
        if (count - 1 < threshold) revert BadThreshold(threshold, count - 1);
        isOwner[owner] = false;
        uint256 index;
        while (_owners[index] != owner) ++index; // owner is in the list (checked above)
        _owners[index] = _owners[count - 1];     // swap with the last one, then shrink
        _owners.pop();
        emit OwnerRemoved(owner);
        _bumpVersion();
    }

    /// @notice Change how many approvals are needed (1 to the number of owners).
    function changeThreshold(uint256 newThreshold) external onlyWallet {
        if (newThreshold == 0 || newThreshold > _owners.length) {
            revert BadThreshold(newThreshold, _owners.length);
        }
        threshold = newThreshold;
        emit ThresholdChanged(newThreshold);
        _bumpVersion();
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getOwners() external view returns (address[] memory) {
        return _owners;
    }

    function transactionCount() external view returns (uint256) {
        return _transactions.length;
    }

    function getTransaction(uint256 txId)
        external
        view
        returns (address to, uint256 value, bytes memory data, bool executed, uint256 approvals, bool stale)
    {
        if (txId >= _transactions.length) revert TxNotFound(txId);
        Transaction storage t = _transactions[txId];
        return (t.to, t.value, t.data, t.executed, t.approvals, t.configVersion != configVersion);
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _addOwner(address owner) private {
        if (owner == address(0) || owner == address(this)) revert InvalidOwner(owner);
        if (isOwner[owner]) revert DuplicateOwner(owner);
        isOwner[owner] = true;
        _owners.push(owner);
        emit OwnerAdded(owner);
    }

    /// @dev Every pending proposal from the old owner set becomes stale.
    function _bumpVersion() private {
        configVersion += 1;
    }
}
