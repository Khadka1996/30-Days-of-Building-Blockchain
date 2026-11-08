// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title TokenVesting
/// @author Manish Khadka
/// @notice Locks team tokens and unlocks them slowly: nothing before a cliff, then in a
///         straight line until the end date (for example 12 months with a 3-month cliff).
///
///         Two promises this contract keeps:
///         1. Rounding can never lose or create tokens. Each payout is worked out from the
///            total ("everything vested so far minus everything already paid"), never from
///            the time since the last claim, so claiming often or rarely ends at the same sum.
///         2. Promised tokens are safe from the owner. A schedule can only be created when
///            spare tokens already back it, and the owner can only withdraw spare tokens.
/// @dev State is always written before tokens move (CEI). There is no pause on purpose:
///      tokens that have vested can never be frozen by the owner.
contract TokenVesting is Ownable2Step {
    using SafeERC20 for IERC20;

    /// @notice Longest allowed schedule. Stops a typo from locking tokens for centuries.
    uint256 public constant MAX_DURATION = 10 * 365 days;
    /// @notice How far ahead a schedule may start. Catches milliseconds passed as seconds.
    uint256 public constant MAX_START_DELAY = 365 days;
    /// @notice Largest schedule. With it, `total * elapsed` can never overflow in `vestedAt`.
    uint256 public constant MAX_TOTAL = type(uint128).max;

    /// @dev Packed into two storage slots to keep creating a schedule cheap.
    struct Schedule {
        uint128 total; // tokens promised (shrinks to the vested part if revoked)
        uint128 released; // tokens already paid out
        uint64 start; // when vesting begins
        uint64 cliffEnd; // nothing can be claimed before this time
        uint64 end; // everything is vested at this time
        bool revocable; // can the owner stop the unvested part?
        bool revoked; // has the owner stopped it?
    }

    /// @notice The token being vested. Fixed forever at deploy.
    /// @dev Kept as `token()` (the name every wallet and script expects) instead of TOKEN.
    // solhint-disable-next-line immutable-vars-naming
    IERC20 public immutable token;

    /// @notice Each beneficiary's single schedule.
    mapping(address beneficiary => Schedule schedule) public schedules;

    /// @notice Tokens this contract still owes to all beneficiaries together.
    uint256 public totalOwed;

    event ScheduleCreated(
        address indexed beneficiary,
        uint256 total,
        uint256 start,
        uint256 cliffEnd,
        uint256 end,
        bool revocable
    );
    event Released(address indexed beneficiary, uint256 amount);
    event Revoked(address indexed beneficiary, uint256 keptVested, uint256 returnedUnvested);
    event SpareWithdrawn(address indexed to, uint256 amount);

    error ZeroAddress();
    error BadBeneficiary();
    error BadAmount();
    error BadTimes();
    error ScheduleExists();
    error NotEnoughSpareTokens(uint256 spare, uint256 needed);
    error NothingToRelease();
    error NoSchedule();
    error NotRevocable();
    error AlreadyRevoked();

    /// @param token_ The ERC-20 token to vest.
    constructor(IERC20 token_) Ownable(msg.sender) {
        if (address(token_) == address(0)) revert ZeroAddress();
        token = token_;
    }

    // ------------------------------------------------------------------------------------
    // Owner
    // ------------------------------------------------------------------------------------

    /// @notice Promise `total` tokens to `beneficiary`. Send the tokens here first.
    /// @param start When vesting begins. Not in the past, and at most 365 days from now.
    /// @param cliffDuration Seconds after `start` before anything can be claimed.
    /// @param duration Seconds from `start` until everything is vested.
    /// @param revocable Whether the owner may later stop the unvested part.
    function createSchedule(
        address beneficiary,
        uint256 total,
        uint256 start,
        uint256 cliffDuration,
        uint256 duration,
        bool revocable
    ) external onlyOwner {
        if (beneficiary == address(0) || beneficiary == address(this)) revert BadBeneficiary();
        if (total == 0 || total > MAX_TOTAL) revert BadAmount();
        if (
            start < block.timestamp ||
            start > block.timestamp + MAX_START_DELAY ||
            duration == 0 ||
            duration > MAX_DURATION ||
            cliffDuration > duration
        ) revert BadTimes();
        if (schedules[beneficiary].total != 0 || schedules[beneficiary].revoked) {
            revert ScheduleExists();
        }

        uint256 spare = spareTokens();
        if (spare < total) revert NotEnoughSpareTokens(spare, total);

        totalOwed += total;
        // The casts are safe: total <= MAX_TOTAL, and every time is checked above.
        schedules[beneficiary] = Schedule({
            total: uint128(total),
            released: 0,
            start: uint64(start),
            cliffEnd: uint64(start + cliffDuration),
            end: uint64(start + duration),
            revocable: revocable,
            revoked: false
        });

        emit ScheduleCreated(beneficiary, total, start, start + cliffDuration, start + duration, revocable);
    }

    /// @notice Stop a revocable schedule, for example when someone leaves the team early.
    ///         What has vested so far stays claimable; the rest becomes spare tokens.
    /// @dev Moves no tokens, so a beneficiary that cannot receive them cannot block this.
    function revoke(address beneficiary) external onlyOwner {
        Schedule storage s = schedules[beneficiary];
        if (s.total == 0 && !s.revoked) revert NoSchedule();
        if (s.revoked) revert AlreadyRevoked();
        if (!s.revocable) revert NotRevocable();

        uint256 total = s.total;
        uint256 vested = _vested(s, block.timestamp);
        uint256 unvested = total - vested;

        s.total = uint128(vested);
        s.revoked = true;
        totalOwed -= unvested;

        emit Revoked(beneficiary, vested, unvested);
    }

    /// @notice Take out tokens that are not promised to anyone. Promised tokens cannot move.
    function withdrawSpare(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 spare = spareTokens();
        if (amount == 0 || amount > spare) revert NotEnoughSpareTokens(spare, amount);
        emit SpareWithdrawn(to, amount);
        token.safeTransfer(to, amount);
    }

    // ------------------------------------------------------------------------------------
    // Beneficiary
    // ------------------------------------------------------------------------------------

    /// @notice Claim everything that has vested so far. Tokens always go to the caller.
    function release() external {
        Schedule storage s = schedules[msg.sender];
        uint256 amount = _vested(s, block.timestamp) - s.released;
        // amount is computed just above, not a balance anyone can nudge from outside.
        // slither-disable-next-line incorrect-equality
        if (amount == 0) revert NothingToRelease();

        s.released += uint128(amount); // amount <= total, which fits in uint128
        totalOwed -= amount;

        emit Released(msg.sender, amount);
        token.safeTransfer(msg.sender, amount);
    }

    // ------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------

    /// @notice Tokens vested for `beneficiary` at `timestamp`, rounded down.
    /// @dev For a revoked schedule this is the amount frozen at the moment of revocation.
    function vestedAt(address beneficiary, uint256 timestamp) external view returns (uint256) {
        return _vested(schedules[beneficiary], timestamp);
    }

    /// @notice Tokens `beneficiary` could claim right now.
    function releasable(address beneficiary) external view returns (uint256) {
        Schedule storage s = schedules[beneficiary];
        return _vested(s, block.timestamp) - s.released;
    }

    /// @notice Tokens held here that are not promised to anyone.
    function spareTokens() public view returns (uint256) {
        uint256 balance = token.balanceOf(address(this));
        return balance > totalOwed ? balance - totalOwed : 0;
    }

    /// @dev The whole vesting formula. Multiply before dividing, so only the last wei rounds.
    function _vested(Schedule storage s, uint256 timestamp) private view returns (uint256) {
        uint256 total = s.total;
        if (total == 0 || s.revoked) return total;
        if (timestamp < s.cliffEnd) return 0;
        if (timestamp >= s.end) return total;
        return (total * (timestamp - s.start)) / (s.end - s.start);
    }
}
