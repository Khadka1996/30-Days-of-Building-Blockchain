# Day 27 — QA and security review

**Scope:** `contracts/GuardedVault.sol` (the vault being watched), the monitor (`monitor/rules.js`, `monitor/monitor.js`, `monitor/store.js`, viem) and the dashboard (`monitor/server.js`, `monitor/public/`). Contracts in `contracts/test/` are deliberately hostile test targets.

**Security focus (ROADMAP):** admin key misuse and unusual withdrawals. The questions:
- if the **owner key is stolen**, can the attacker change something before anyone can react? Does the monitor see it, and can it stop it?
- can a thief **drain the vault without tripping an alert** (split into small withdrawals, spread over addresses, or after muting the alert)?
- can the monitor be **fooled** (fake events, unconfirmed blocks, restarts, a bad RPC) or turned into a weapon (pausing on old history, cancelling the wrong change)?

All monitor tests run against a **live local chain** through viem, with the guardian key sending real transactions.

## How it was tested

| Layer | Tool | What it covers |
|---|---|---|
| Contract | Hardhat + chai (15 tests) | Deposits/withdrawals and their events, balances, re-entrancy, plain ETH refused, net daily limit (across all members, resets daily, F-1 griefing), timelock (too early, exact eta, no silent overwrite), guardian change, owner-only admin, bad values, guardian cancel, two-step ownership, pause/unpause rights |
| Monitor | viem on a live chain (17 tests) | Quiet normal day, large withdrawal, split drain → alert once + auto-pause, F-2 escalation, F-4 whale, daily-limit warning, unannounced change → auto-cancel, announced change left alone, stale cancel (only the exact change), unknown owner → pause, 2 confirmations, look-alike contract via a lying RPC, restart from file, RPC range limits, RPC outage, old history (F-3), alert-only mode |
| Browser | Playwright + Chromium (3 tests) | Live dashboard (tiles, alerts, responses, queued changes), XSS in every text field, Host check, read-only, path tricks |
| Fuzz | fast-check (2 properties) | 400 random withdrawal sequences (sizes, timing, addresses) → the outflow alert never misses a drain, never fires falsely, never repeats unless the outflow doubled. 25 random live runs with 130 random crashes → exactly the same alerts as a monitor that never stopped, no duplicates, books match the chain |
| Test of the tests | `npm run planted-bugs` | 21 real bugs planted one at a time (9 contract, 10 monitor, 2 dashboard); the suite must fail for each |
| Tooling | npm audit · solhint · Slither | Dependencies, lint, static analysis |

## Findings (found and fixed during QA)

Each was found after the first green run, proven with a failing test, then fixed.

| ID | Severity | Found by | Description | Fix | Proving test |
|---|---|---|---|---|---|
| F-1 | **Medium** | Manual review (attacker view) | **The circuit breaker could lock everyone out.** The first daily limit counted gross withdrawals. One rich member could withdraw the whole 50 ETH limit at 00:01 and deposit it straight back: their money is safe, but nobody else can withdraw for the rest of the day, every day, for the price of gas. | The limit counts **net** outflow: `dailyLimit + today's deposits − today's withdrawals`. Withdraw-and-redeposit uses nothing; a real drain (no ETH coming back) is still capped. The monitor's DAILY_LIMIT_NEAR rule uses the same maths. | `GuardedVault.test.js` › F-1 (failed before the fix: `leftToday` was 0 instead of 50 ETH); planted "deposits don't refill the limit" caught |
| F-2 | **Medium** | Manual review (attacker view) | **A small spike could mute the alert for a big drain.** To avoid spam, OUTFLOW_SPIKE fired once per hour. In alert-only mode (no guardian key), an attacker could trip it with a 30% outflow and then take another 30% in the same hour with no new alert. | A muted OUTFLOW_SPIKE fires again ("still growing") whenever the outflow in the window **doubles** since the last alert. | `monitor.test.js` › F-2 (failed before the fix: `['36 ETH']` instead of `['36 ETH','72 ETH']`); fuzz property "no spam" now allows only doubling repeats; planted "never escalates" caught |
| F-3 | Low | Demo run | Alerts that never have an automatic response (PAUSED, BURST…) showed "not acted on: older than the response window" when the monitor caught up on older blocks: misleading during an incident. | Decide the action first; only alerts that have one get a response note. | `monitor.test.js` › does not act on old history (BURST response must be empty; failed before the fix) |
| F-4 | Low | Demo run | **One member's own withdrawal paused everyone.** A whale taking 25 ETH (32% of a smaller vault) in a single transaction also counted as OUTFLOW_SPIKE (critical), so the guardian paused the vault for all members. | OUTFLOW_SPIKE needs **at least 2 withdrawals** in the window: it is the split-drain rule. A single big withdrawal stays LARGE_WITHDRAWAL (high, for a human to check), and it is capped by the daily limit anyway. | `monitor.test.js` › F-4 (failed before the fix: `['LARGE_WITHDRAWAL/high','OUTFLOW_SPIKE/critical']`) |

No high or medium findings are left open.

## Built-in defences (each has a test; the planted bug shows the test can fail)

| ID | Attack | Defence | Planted bug caught |
|---|---|---|---|
| D-01 | **Stolen owner key changes a setting** | 24 h timelock, `ChangeQueued` event with the eta; UNANNOUNCED_CHANGE → guardian `cancel` | timelock skipped · rated info |
| D-02 | **Second queue hides the first** | `AlreadyQueued`: a change must be cancelled before another is queued | silent replace |
| D-03 | **Monitor cancels the wrong change** | Cancel only if `pending(kind)` still has the alert's exact value and eta | cancels whatever is queued |
| D-04 | **Stolen guardian key** | Guardian can only pause and cancel; only the owner unpauses | guardian may unpause · anyone may pause · anyone may cancel |
| D-05 | **Admin action from an unexpected address** | UNKNOWN_ADMIN (critical) → pause; ownership to an unknown address is critical | unknown admins not checked |
| D-06 | **Split drain** | Rolling 1 h window over all addresses (≥ 30%, ≥ 2 withdrawals) → pause; net daily limit on-chain | only sees the last withdrawal · no daily limit check |
| D-07 | **Single large withdrawal** | LARGE_WITHDRAWAL (≥ 20%) | threshold 10× too high |
| D-08 | **Re-entrancy / accounting** | `nonReentrant`, checks → effects → interaction | no guard · balance not reduced |
| D-09 | **Fake events** | Logs filtered by address in the query **and** re-checked after (a lying or misconfigured RPC) | trusts logs from any contract |
| D-10 | **Reorgs / unconfirmed data** | Only blocks with 2 confirmations | ignores confirmations |
| D-11 | **Missed or doubled events on restart** | Cursor + rule state saved per chunk (atomic file write), alert ids deduplicated | progress not saved |
| D-12 | **Pausing on old history** | Only responds to alerts from the last hour of chain time | acts on old history |
| D-13 | **Dashboard attacks** | Read-only, 127.0.0.1 only, Host check (DNS rebinding), fixed file list, CSP `default-src 'none'`, `textContent` only | no Host check · alert text as HTML |

Also checked: zero amounts, other members' balances, plain ETH transfers (refused), limit of 0 or above 10,000 ETH, guardian 0, executing with nothing queued, RPC block-range limits (ranges split), RPC outage (error shown, next poll recovers), no guardian key (alerts only), deposits and withdrawals while paused.

## Static analysis and dependencies

- `npm audit --omit=dev`: **0 vulnerabilities** (runtime dependency: `viem`).
- `solhint`: **0 problems**.
- `slither`: **0 results** (`contracts/test/` excluded: deliberately hostile). One `low-level-calls` note on the ETH send in `withdraw` was reviewed and silenced inline: state is updated first and the function is `nonReentrant`.

## Known issues and limits (by design for a learning project)

- **Deep reorgs.** The monitor waits 2 confirmations. A deeper reorg could leave an alert for an event that no longer exists (it never misses one). Day 23's indexer shows full reorg handling; on Ethereum mainnet, wait for finality for anything automatic.
- **Single owner key.** A stolen owner key can still start an ownership transfer or unpause. The monitor flags both as critical, but only a **multisig owner** (Day 4) really fixes this.
- **The monitor is a target too.** If it is offline, nothing responds (the timelock and daily limit still hold). Run two monitors on different machines and RPCs, and alert a human (email/phone) for every critical alert.
- **Thresholds are guesses.** 20% / 30% / 8 per 10 min fit this small vault; real protocols tune them from history and accept some false alarms.
- **Pausing hurts honest users.** That is why only two rules pause automatically and the owner can unpause after checking.

## Final green output

```
$ npm test
  Day 27 — GuardedVault (the contract being watched)    15 passing
  Day 27 — the dashboard in a browser                    3 passing
  Day 27 — fuzzing                                       2 passing
      fuzz: 400 random withdrawal sequences, 864 drain moments, 295 alerts, 0 missed, 0 false
      fuzz: 25 random live runs, 130 crashes, 38 alerts — identical to a monitor that never stopped
  Day 27 — the monitor on a live chain (viem)           17 passing

  37 passing (7s)

$ npm run planted-bugs
 1. CAUGHT  no daily limit check
 2. CAUGHT  deposits don't refill the limit (F-1 griefing)
 3. CAUGHT  timelock skipped
 4. CAUGHT  a queued change can be silently replaced
 5. CAUGHT  guardian may unpause
 6. CAUGHT  anyone may pause
 7. CAUGHT  anyone may cancel a queued change
 8. CAUGHT  no re-entrancy guard
 9. CAUGHT  balance not reduced on withdraw
10. CAUGHT  outflow rule only sees the last withdrawal (split drains missed)
11. CAUGHT  muted outflow alert never escalates (F-2)
12. CAUGHT  unannounced admin change rated info
13. CAUGHT  unknown admins not checked
14. CAUGHT  large-withdrawal threshold 10x too high
15. CAUGHT  monitor trusts logs from any contract
16. CAUGHT  monitor ignores confirmations
17. CAUGHT  progress not saved (restart re-reads everything)
18. CAUGHT  acts on old history
19. CAUGHT  cancels whatever is queued, not the change it alerted on
20. CAUGHT  no Host check (DNS rebinding)
21. CAUGHT  page renders alert text as HTML

21 of 21 planted bugs caught

$ npm audit --omit=dev       found 0 vulnerabilities
$ npm run lint               0 problems
$ npm run slither            9 contracts analyzed with 101 detectors, 0 result(s) found
```
