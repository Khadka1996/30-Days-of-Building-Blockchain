# Day 09 — QA and security review

**Contracts:** `contracts/TokenVesting.sol`, `contracts/HimalToken.sol` (same as Day 08) · **Security focus:** rounding errors, early claims

## How it was checked

1. Unit tests for every function, custom error and event (`npx hardhat test`), including the exact edges: 1 second before the cliff pays nothing, the cliff second pays exactly 3 months; the end date pays exactly the total.
2. Rounding tests: a tiny 1,000-wei grant claimed **365 times** must pay exactly 1,000; a total that does not divide evenly must pay the same whether it is claimed monthly or once.
3. Attack-style tests: a beneficiary contract that claims again while being paid (reentrancy), two claims in one block, a stranger claiming someone's tokens, and an owner trying to take promised tokens.
4. A fuzz test with **fast-check**: 100 random histories of claims, revokes and waits (up to 20 months each), checked after every step against a simple JavaScript model: `totalOwed` always matches, the contract always holds enough, and at the end everyone collects exactly what they are owed and the contract is empty.
5. Mutation check: 8 key lines were broken on purpose, one at a time (no cliff check, no funding check, owner can withdraw promised tokens, double payment, revoke not freezing the schedule, revoke not updating `totalOwed`, no end cap, schedule overwrite). The tests caught all 8.
6. `npm audit --omit=dev`, `solhint` (recommended rules), `slither`.
7. Manual review like an attacker: rounding, early claims, revocation, owner powers, overflow, reentrancy, access control, input validation.

## Findings

F-01 to F-08 came from the attacker review of the design before the first build (each threat is written as a test that would fail on the naive version); F-09 came from slither and solhint on the first build.

| ID | Severity | Found by | Description | Fix | Proving test |
|----|----------|----------|-------------|-----|--------------|
| F-01 | High | Design review | **Rounding loses tokens.** Paying `total × timeSinceLastClaim ÷ duration` rounds down on every claim. A 1,000-wei grant claimed daily for a year pays only 730: 27% is stuck forever, and frequent claimers get less than patient ones. | Every payout is cumulative: `vested so far − already released`. Rounding can only delay the last wei to the next claim, and the end date pays exactly the total. | `365 daily claims of a tiny 1,000-wei grant pay exactly 1,000`, `claiming often and claiming once end at exactly the same total` |
| F-02 | High | Design review | **Owner can take promised tokens.** A plain `withdraw` lets the owner empty the contract and leave the team with nothing. | The contract tracks `totalOwed`. `withdrawSpare` can only move `balance − totalOwed`. There is no pause, so vested tokens cannot be frozen either. | `withdraws spare tokens only; one wei more fails`, `after the owner takes all spare tokens the beneficiary still gets everything` |
| F-03 | High | Design review | **Promises without tokens.** If schedules are not checked against the balance, the last people to claim find the contract empty. | `createSchedule` requires the spare tokens to be there already (`NotEnoughSpareTokens`). | `cannot promise more tokens than it holds`, fuzz invariant (balance ≥ owed) |
| F-04 | Medium | Design review | **Revoke takes earned tokens, or pays twice.** Revoking could confiscate what has already vested, or let the schedule keep vesting. | `revoke` freezes the schedule at the vested amount and frees only the unvested part. It moves no tokens, so a beneficiary cannot block it. | `keeps what has vested claimable…`, `revoke after a partial claim does not pay the same tokens twice`, `before the cliff everything returns to spare` |
| F-05 | Medium | Design review | **Early claims.** An off-by-one at the cliff, or a claim before the start, would pay early. | `timestamp < cliffEnd` returns 0; the exact cliff second pays. Before the start is always below the cliff, so subtraction cannot underflow. | `a claim one second before the cliff fails…`, `is 0 before the start…` |
| F-06 | Medium | Design review | **Bad parameters brick a schedule.** Duration 0 divides by zero; a start in milliseconds locks tokens for thousands of years; a huge total overflows `total × elapsed` and blocks `release` forever. | Duration 1 second to 10 years, start within 365 days and not in the past, cliff ≤ duration, total ≤ `uint128` max (so the multiplication always fits). | `rejects bad times…`, `rejects bad beneficiaries and amounts`, `the largest allowed schedule over the longest time does not overflow` |
| F-07 | Medium | Design review | **Overwriting a schedule.** A second `createSchedule` could erase `released` and pay the same tokens again. | One schedule per address, also after revoke (`ScheduleExists`). | `one schedule per address: an active or revoked one cannot be overwritten` |
| F-08 | Low | Design review | **Reentrancy.** A token with a transfer hook could call `release` again during the payment. | State is written before the transfer (CEI), so the second call finds nothing. | `a beneficiary contract cannot claim twice while being paid (reentrancy)` |
| F-09 | Info | slither (`incorrect-equality`, `timestamp`), solhint | `amount == 0` is flagged, time comparisons are flagged, and the immutable `token` name is not `SNAKE_CASE`. | False positives here. `amount` is computed in the same line, not a balance anyone can nudge. Vesting must use time, and validators can only shift it by seconds. Disabled on that line, excluded in `slither.config.json`, and on the `token` line, each with a reason. | `a claim one second before the cliff fails…` |

No high or medium issues remain open.

## Known issues (by design, documented)

- **Revocable schedules trust the owner.** The owner can stop the unvested part of a revocable schedule. Schedules created with `revocable = false` cannot be stopped; the flag is public and shown in the event.
- **Lost key = lost tokens.** A beneficiary cannot change their address. A real product would add a two-step address change.
- **Standard tokens only.** Fee-on-transfer or rebasing tokens would make the books drift. This contract is meant for a plain ERC-20 such as HIM.
- **Other tokens sent here are stuck.** `withdrawSpare` only handles the vesting token.
- **Only one schedule per address.** Giving someone a second grant needs a second vesting contract or address.
- **Renouncing ownership** ends revocation for good; beneficiaries keep getting paid (tested).

## Final run

```
28 passing
npm audit --omit=dev: found 0 vulnerabilities
solhint: 0 warnings, 0 errors
slither: 0 results
Mutation check: 8 of 8 caught
```
