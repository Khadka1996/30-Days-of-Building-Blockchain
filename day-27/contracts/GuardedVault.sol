// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title GuardedVault — Day 27: a community ETH vault built to be watched
/// @author Manish Khadka
/// @notice Members deposit ETH and withdraw their own. The contract is written so that
///         an off-chain monitor (monitor/) can SEE every risky action and has TIME to react:
///         - every admin change is queued first and only takes effect after `DELAY` (timelock),
///         - a guardian (the monitor's key) can pause and cancel queued changes, nothing else,
///         - total withdrawals per day are capped (a circuit breaker for drains),
///         - every action emits an event with the numbers the monitor needs.
///         The Day 2 piggy bank's rule still holds: checks → effects → interaction.
contract GuardedVault is Ownable2Step, Pausable, ReentrancyGuard {
    /// @notice How long a queued admin change waits before it can be executed.
    uint256 public constant DELAY = 1 days;
    /// @notice The guardian can never set a limit above this (keeps typos from disabling the breaker).
    uint256 public constant MAX_DAILY_LIMIT = 10_000 ether;

    enum Kind { DailyLimit, Guardian }

    struct Pending {
        uint256 value; // new limit, or uint256(uint160(newGuardian))
        uint64 eta; // 0 = nothing queued
    }

    mapping(address => uint256) public balanceOf;
    /// @notice Sum of all members' balances. Not `address(this).balance`: forced ETH can't skew it.
    uint256 public totalDeposits;

    address public guardian;
    /// @notice Max NET ETH that may leave the vault per UTC day, across all members.
    uint256 public dailyLimit;
    /// @notice The day number (timestamp / 1 days) and how much came in / went out on that day.
    ///         Deposits on the same day refill the limit (F-1): someone who withdraws a lot and
    ///         puts it back can't lock everyone else out, while a real drain is still capped.
    uint256 public flowDay;
    uint256 public inflowToday;
    uint256 public outflowToday;

    mapping(Kind => Pending) public pending;

    event Deposited(address indexed user, uint256 amount, uint256 totalAfter);
    event Withdrawn(address indexed user, uint256 amount, uint256 totalAfter);
    event ChangeQueued(Kind indexed kind, uint256 value, uint256 eta, address indexed by);
    event ChangeCancelled(Kind indexed kind, uint256 value, address indexed by);
    event ChangeExecuted(Kind indexed kind, uint256 oldValue, uint256 newValue, address indexed by);

    error ZeroAmount();
    error InsufficientBalance(uint256 balance, uint256 amount);
    error DailyLimitExceeded(uint256 leftToday, uint256 amount);
    error NotGuardianOrOwner();
    error BadValue();
    error AlreadyQueued(Kind kind);
    error NothingQueued(Kind kind);
    error TooEarly(uint256 eta);
    error TransferFailed();

    modifier onlyGuardianOrOwner() {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardianOrOwner();
        _;
    }

    constructor(address guardian_, uint256 dailyLimit_) Ownable(msg.sender) {
        if (guardian_ == address(0) || dailyLimit_ == 0 || dailyLimit_ > MAX_DAILY_LIMIT) revert BadValue();
        guardian = guardian_;
        dailyLimit = dailyLimit_;
    }

    // ───────────────────────── members ─────────────────────────

    function deposit() external payable whenNotPaused {
        if (msg.value == 0) revert ZeroAmount();
        _rollDay();
        inflowToday += msg.value;
        balanceOf[msg.sender] += msg.value;
        totalDeposits += msg.value;
        emit Deposited(msg.sender, msg.value, totalDeposits);
    }

    /// @notice Withdraw your own ETH, within today's vault-wide limit.
    function withdraw(uint256 amount) external nonReentrant whenNotPaused {
        // checks
        if (amount == 0) revert ZeroAmount();
        uint256 bal = balanceOf[msg.sender];
        if (amount > bal) revert InsufficientBalance(bal, amount);
        _rollDay();
        uint256 left = _left();
        if (amount > left) revert DailyLimitExceeded(left, amount);
        // effects
        outflowToday += amount;
        balanceOf[msg.sender] = bal - amount;
        totalDeposits -= amount;
        emit Withdrawn(msg.sender, amount, totalDeposits);
        // interaction
        // slither-disable-next-line low-level-calls (plain ETH send; state is already updated and nonReentrant)
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice How much may still leave the vault today.
    function leftToday() external view returns (uint256) {
        if (block.timestamp / 1 days != flowDay) return dailyLimit;
        return _left();
    }

    // ───────────────────────── admin: timelocked ─────────────────────────

    /// @notice Queue a new daily limit. It can be executed after DELAY.
    function queueDailyLimit(uint256 newLimit) external onlyOwner {
        if (newLimit == 0 || newLimit > MAX_DAILY_LIMIT) revert BadValue();
        _queue(Kind.DailyLimit, newLimit);
    }

    /// @notice Queue a new guardian. It can be executed after DELAY.
    function queueGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == address(0)) revert BadValue();
        _queue(Kind.Guardian, uint256(uint160(newGuardian)));
    }

    /// @notice Apply a queued change once its delay has passed.
    function execute(Kind kind) external onlyOwner {
        Pending memory p = pending[kind];
        if (p.eta == 0) revert NothingQueued(kind);
        if (block.timestamp < p.eta) revert TooEarly(p.eta);
        delete pending[kind];
        uint256 old;
        if (kind == Kind.DailyLimit) {
            old = dailyLimit;
            dailyLimit = p.value;
        } else {
            old = uint256(uint160(guardian));
            guardian = address(uint160(p.value));
        }
        emit ChangeExecuted(kind, old, p.value, msg.sender);
    }

    /// @notice The guardian (or owner) can cancel a queued change, e.g. after a monitor alert.
    function cancel(Kind kind) external onlyGuardianOrOwner {
        Pending memory p = pending[kind];
        if (p.eta == 0) revert NothingQueued(kind);
        delete pending[kind];
        emit ChangeCancelled(kind, p.value, msg.sender);
    }

    // ───────────────────────── emergency ─────────────────────────

    /// @notice The guardian (or owner) can pause deposits and withdrawals at once.
    function pause() external onlyGuardianOrOwner {
        _pause();
    }

    /// @notice Only the owner can unpause: a stolen guardian key can stop the vault, never drain it.
    function unpause() external onlyOwner {
        _unpause();
    }

    // ───────────────────────── internal ─────────────────────────

    /// @dev Start a fresh count on a new UTC day.
    function _rollDay() private {
        uint256 today = block.timestamp / 1 days;
        if (today != flowDay) {
            flowDay = today;
            inflowToday = 0;
            outflowToday = 0;
        }
    }

    /// @dev dailyLimit + today's deposits − today's withdrawals (never below 0).
    function _left() private view returns (uint256) {
        uint256 cap = dailyLimit + inflowToday;
        return outflowToday >= cap ? 0 : cap - outflowToday;
    }

    function _queue(Kind kind, uint256 value) private {
        // No silent overwrite: a queued change must be cancelled first, so the monitor
        // never watches an eta that a second queue quietly replaced.
        if (pending[kind].eta != 0) revert AlreadyQueued(kind);
        uint64 eta = uint64(block.timestamp + DELAY);
        pending[kind] = Pending(value, eta);
        emit ChangeQueued(kind, value, eta, msg.sender);
    }
}
