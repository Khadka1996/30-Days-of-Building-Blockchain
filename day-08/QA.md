# Day 08 — QA and security review

**Contracts:** `contracts/HimalToken.sol`, `contracts/Faucet.sol` · **Security focus:** faucet draining with many addresses

## How it was checked

1. Unit tests for the token (supply, no mint function, transfers and allowances) and for every faucet function, custom error and event (`npx hardhat test`), including the exact edges: 1 second before 24 hours fails, exactly 24 hours works; 23:59:59 UTC is still "today", 00:00:00 UTC is a new budget.
2. Attack-style tests: one attacker contract that creates **50 brand-new addresses in one transaction** and claims from each; the same attack every day for 7 days; a contract that claims twice in one transaction; an attack while paused.
3. A fuzz test with **fast-check**: 100 random sequences of claims by 6 addresses with random waits (seconds, around 24 hours, up to 2 days) and a tight budget of 3 claims a day, checked step by step against a simple JavaScript model, plus invariants (no tokens created or lost; `givenToday` never above the budget; no UTC day ever over budget).
4. `npm audit --omit=dev`, `solhint` (recommended rules), `slither`.
5. Manual review like an attacker: many addresses (Sybil), cooldown edges, budget reset edges, owner powers, empty faucet, reentrancy and the order of effects, access control, input validation.

## Findings

F-01 to F-06 came from the attacker review of the design before the first build (each threat is written as a test that would fail on the naive version); F-07 and F-08 came from slither and solhint on the first build. Each one is now guarded by a test.

| ID | Severity | Found by | Description | Fix | Proving test |
|----|----------|----------|-------------|-----|--------------|
| F-01 | High | Design review | **Draining with many addresses.** The textbook faucet only checks "has this address claimed today?". New addresses are free, so one script (or one contract deploying throw-away contracts) can claim thousands of times and empty the faucet in a single transaction. | A **global daily budget** (`dailyBudget`, 1,000 HIM) on top of the per-address limit. Once it is used up, every claim reverts with `DailyBudgetUsed` until 00:00 UTC. The worst case is one budget per day. | `one attacker with 50 brand-new contract addresses in one transaction gets only one day's budget`, `attacking every day for 7 days takes at most 7 budgets`, fuzz invariant |
| F-02 | Medium | Design review | **"Once a day" by calendar day.** If the per-address rule used the UTC day number, an address could claim at 23:59 and again at 00:01: two claims in two minutes. | The per-address rule is a rolling **24 hours** (`COOLDOWN`), measured from the last claim. Only the shared budget uses the calendar day. | `a new UTC day does not reset an address's own 24-hour wait`, `… 1 second early fails, exactly 24 hours works` |
| F-03 | Medium | Design review | **Budget reset edge.** A budget counter that is never reset locks the faucet forever after day one; one that resets on the wrong day (or keeps yesterday's count) blocks or over-pays. | `currentDay` and `givenToday` are updated together in `claim`; a claim on a later day starts the count at zero. `remainingToday` uses the same rule. | `the budget starts again at 00:00 UTC` (23:59:59 fails, 00:00:00 works), fuzz model |
| F-04 | Medium | Design review | **Unsafe limits.** An owner typo such as a zero drip, or a drip bigger than the budget, would break the faucet or remove the budget's protection. Lowering the budget mid-day must not underflow. | `setLimits` (and the constructor) require `drip > 0` and `budget ≥ drip` (`BadLimits`). `remainingToday` returns 0 instead of underflowing when the budget is lowered below what was already given. | `setLimits keeps the drip above zero and inside the budget`, `lowering the budget mid-day takes effect at once`, `rejects a zero token, a zero drip…` |
| F-05 | Medium | Design review | **No way to stop an attack.** Without an emergency stop, the owner can only watch while a budget is taken day after day. | `Pausable`: `pause()` / `unpause()`, owner only. | `the owner can pause the faucet during an attack`, `pause stops every claim until unpause` |
| F-06 | Low | Design review | **Wrong person or partial payouts.** A `claimFor(address)` or a `tx.origin` check would let others spend someone's turn, or break smart-contract wallets (and an "only humans" check with `tx.origin` stops nothing: EOAs are free too). Sending "whatever is left" from an almost-empty faucet hides that it is empty. | Tokens always go to `msg.sender`; no `tx.origin`. A claim is all-or-nothing (`FaucetEmpty`). Ownership uses `Ownable2Step` so a typo cannot hand the faucet to a wrong address. | `never gives a partial amount…`, `a contract cannot claim twice in one transaction`, `ownership moves in two steps` |
| F-07 | Low | slither (`reentrancy-events`, `incorrect-equality`) | The first build emitted `Claimed` / `Withdrawn` **after** the token transfer, and used `==` on the day number and on `last == 0`. | Events now come before the transfer, so the transfer is the very last step (checks → effects → interaction). The day check uses `today > currentDay` and `waitTime` no longer needs `== 0`. | all `claim` tests, `waitTime and remainingToday tell users what they can do` |
| F-08 | Info | slither (`timestamp`), solhint | Cooldown and budget compare `block.timestamp`; solhint wants immutables in `SNAKE_CASE`; low-level calls in the test-only attacker. | Accepted: a daily faucet must use time, and validators can only shift it by seconds. `timestamp` is excluded in `slither.config.json` with this reason. `token` keeps its standard name (disabled on that line only, with a comment). Test helpers excluded from slither, their rules disabled in that file only. | `the budget starts again at 00:00 UTC` (exact edge) |

No high or medium issues remain open.

## Known issues (by design, documented)

| ID | Description | Why it is accepted today |
|----|-------------|--------------------------|
| K-01 | **Budget griefing.** An attacker with many addresses can use up the whole budget right after 00:00 UTC every day, so honest users get nothing that day. | The damage is capped at one budget per day and the owner can pause. On-chain code cannot tell a person from an address; real faucets add a captcha signed by a server, a "must hold some mainnet ETH" rule or proof-of-personhood. |
| K-02 | **The owner can withdraw everything.** | The owner funded the faucet; it is their tokens. It is visible on-chain (`Withdrawn` event). |
| K-03 | `givenToday` counts what the faucet sent, not what arrived. | The faucet's token is fixed at deploy and HIM has no transfer fees; a fee-on-transfer token would need balance-difference accounting. |

## Final green run

```
  HimalToken
    ✔ has a name, symbol, 18 decimals and sends the whole fixed supply to the deployer (383ms)
    ✔ has no mint function: nobody can ever create more tokens
    ✔ transfers, approves and transferFrom like any ERC-20

  Faucet
    setup
      ✔ stores the token, drip, budget and owner
      ✔ rejects a zero token, a zero drip and a budget smaller than one drip
    claim
      ✔ gives the drip to the caller and emits Claimed with the next allowed time
      ✔ an address waits a full 24 hours: 1 second early fails, exactly 24 hours works
      ✔ a new UTC day does not reset an address's own 24-hour wait
      ✔ never gives a partial amount: an almost-empty faucet says FaucetEmpty
      ✔ waitTime and remainingToday tell users what they can do
    daily budget
      ✔ 10 different addresses claim, the 11th is told to come back tomorrow
      ✔ the budget starts again at 00:00 UTC
    owner controls
      ✔ only the owner can change limits, pause, unpause and withdraw
      ✔ setLimits keeps the drip above zero and inside the budget
      ✔ lowering the budget mid-day takes effect at once
      ✔ pause stops every claim until unpause
      ✔ withdraw sends tokens out, never to the zero address
      ✔ ownership moves in two steps: the new owner must accept
    security: draining with many addresses
      ✔ one attacker with 50 brand-new contract addresses in one transaction gets only one day's budget
      ✔ attacking every day for 7 days takes at most 7 budgets; the faucet is never emptied (74ms)
      ✔ a contract cannot claim twice in one transaction
      ✔ the owner can pause the faucet during an attack
    fuzz: random claims by 6 addresses at random times
      ✔ matches a simple model; never more than the budget per day, never twice in 24 hours (100 random runs) (4218ms)


  23 passing (5s)
```

| Tool | Result |
|------|--------|
| `npm audit --omit=dev` | found 0 vulnerabilities |
| `solhint` (recommended) | 0 warnings, 0 errors |
| `slither` (101 detectors) | 0 results (after fixing F-07; `timestamp` excluded with the reason in F-08; test helpers and `node_modules` excluded) |
