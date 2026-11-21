// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IPiggyBank} from "./IPiggyBank.sol";

/// @title PiggyBank — save ETH and lock it until a date you choose
/// @author Manish Khadka
/// @notice Every address has its own piggy bank. You pick an unlock date when you
///         first put money in. You can add more at any time and push the date
///         later, but you can never move it earlier. After the unlock date only
///         YOU can take the money out. There is no admin: nobody else, not even
///         the person who deployed this contract, can touch your savings.
contract PiggyBank is IPiggyBank {
    /// @notice One person's piggy bank.
    struct Bank {
        uint128 balance;   // wei saved (uint128 holds far more ETH than exists)
        uint64 unlockAt;   // unix time (seconds) when withdrawing becomes possible
    }

    /// @notice Longest lock allowed. Stops typos like passing milliseconds
    ///         (which would lock the money for ~50,000 years).
    uint256 public constant MAX_LOCK_DURATION = 10 * 365 days;

    /// @notice Sum of every bank's balance. Kept separately from
    ///         address(this).balance, which anyone can inflate by force-sending ETH.
    uint256 public totalLocked;

    mapping(address => Bank) private _banks;

    event Deposited(address indexed owner, uint256 amount, uint256 newBalance, uint64 unlockAt);
    event LockExtended(address indexed owner, uint64 oldUnlockAt, uint64 newUnlockAt);
    event Withdrawn(address indexed owner, uint256 amount);

    error ZeroDeposit();
    error UnlockNotInFuture(uint64 unlockAt, uint256 nowTs);
    error LockTooLong(uint64 unlockAt, uint256 maxUnlockAt);
    error LockAlreadySet(uint64 currentUnlockAt);
    error NoActiveBank();
    error CannotShortenLock(uint64 currentUnlockAt, uint64 requested);
    error StillLocked(uint64 unlockAt, uint256 nowTs);
    error NothingToWithdraw();
    error TransferFailed();

    /// @notice Put ETH into YOUR piggy bank.
    /// @param unlockAt For an empty bank: the unlock time (unix seconds, in the
    ///        future, at most MAX_LOCK_DURATION away). For a bank that already
    ///        holds money: pass 0 to add to it with the same unlock date.
    function deposit(uint64 unlockAt) external payable override {
        if (msg.value == 0) revert ZeroDeposit();
        Bank storage bank = _banks[msg.sender];

        if (bank.balance == 0) {
            _checkUnlockTime(unlockAt);
            bank.unlockAt = unlockAt;
        } else if (unlockAt != 0) {
            // A second deposit must not be able to change the date (and above
            // all must not move it earlier). Use extendLock to push it later.
            revert LockAlreadySet(bank.unlockAt);
        }

        bank.balance += uint128(msg.value);
        totalLocked += msg.value;

        emit Deposited(msg.sender, msg.value, bank.balance, bank.unlockAt);
    }

    /// @notice Push YOUR unlock date later. It can never be moved earlier.
    function extendLock(uint64 newUnlockAt) external {
        Bank storage bank = _banks[msg.sender];
        if (bank.balance == 0) revert NoActiveBank();
        uint64 current = bank.unlockAt;
        if (newUnlockAt <= current) revert CannotShortenLock(current, newUnlockAt);
        _checkUnlockTime(newUnlockAt);

        bank.unlockAt = newUnlockAt;
        emit LockExtended(msg.sender, current, newUnlockAt);
    }

    /// @notice Take ALL your ETH out, once the unlock date has passed.
    /// @dev Checks → effects → interaction: the balance is set to zero BEFORE
    ///      the ETH is sent, so a contract that calls back in finds nothing left.
    function withdraw() external override {
        // 1. Checks
        Bank memory bank = _banks[msg.sender];
        if (bank.balance == 0) revert NothingToWithdraw();
        // Miners/validators can shift block.timestamp by only a few seconds,
        // which does not matter for locks measured in days.
        // solhint-disable-next-line not-rely-on-time
        if (block.timestamp < bank.unlockAt) revert StillLocked(bank.unlockAt, block.timestamp);

        // 2. Effects
        delete _banks[msg.sender]; // balance = 0, unlockAt = 0: the bank can be reused
        totalLocked -= bank.balance;
        emit Withdrawn(msg.sender, bank.balance);

        // 3. Interaction (call, not transfer: smart-contract wallets need more than 2300 gas)
        // solhint-disable-next-line avoid-low-level-calls
        (bool ok, ) = payable(msg.sender).call{value: bank.balance}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Read anyone's piggy bank (everything on-chain is public).
    function getBank(address owner) external view returns (uint256 balance, uint64 unlockAt) {
        Bank memory bank = _banks[owner];
        return (bank.balance, bank.unlockAt);
    }

    /// @notice Seconds until `owner` can withdraw (0 if unlocked or empty).
    function timeLeft(address owner) external view returns (uint256) {
        uint64 unlockAt = _banks[owner].unlockAt;
        // solhint-disable-next-line not-rely-on-time
        return block.timestamp >= unlockAt ? 0 : unlockAt - block.timestamp;
    }

    /// @dev An unlock time must be in the future but not absurdly far away.
    function _checkUnlockTime(uint64 unlockAt) private view {
        // solhint-disable-next-line not-rely-on-time
        uint256 nowTs = block.timestamp;
        if (unlockAt <= nowTs) revert UnlockNotInFuture(unlockAt, nowTs);
        if (unlockAt > nowTs + MAX_LOCK_DURATION) revert LockTooLong(unlockAt, nowTs + MAX_LOCK_DURATION);
    }
}
