# Day 04 — QA and security review

**Contract:** `contracts/MultiSigWallet.sol` · **Security focus:** replay, approving twice, removed owners

## How it was checked

1. Unit tests for every function, every custom error and every event (`npx hardhat test`)
2. Attack-style tests: a stranger trying every function, approving twice, approve → revoke → approve, replaying an executed proposal, re-entering `execute` from inside a payment (with an attacker contract that is an owner), an approval from a removed owner, a removed-and-re-added owner, lowering the threshold to unlock an old proposal, removing owners below the threshold
3. A fuzz test with **fast-check**: 50 random sequences of submit / approve / revoke / execute by the 3 owners and a stranger, checked step by step against a simple JavaScript model, plus invariants (the wallet balance only drops by executed payments; on-chain approval counts and `executed` flags match the model)
4. `npm audit --omit=dev`, `solhint` (recommended rules), `slither`
5. Manual review like an attacker: replay, double approval, owner changes, access control, reentrancy, failed calls, input validation, denial of service

## Findings

F-01 to F-08 came from the manual review of the first design, before the first commit; F-09 to F-11 came from slither and solhint on the first build. Each one is now guarded by a test.

| ID | Severity | Found by | Description | Fix | Proving test |
|----|----------|----------|-------------|-----|--------------|
| F-01 | High | Manual review | **Removed owners.** Approvals were only counted, so an approval given by an owner who was later removed still counted. One remaining owner plus the removed owner's old approval reached 2 of 3. | Every owner or threshold change bumps `configVersion`. A proposal remembers its version; once the version changes, `approve` and `execute` revert with `StaleTransaction`. | `an approval from a removed owner cannot be used to move money`, `a removed and re-added owner does not get old approvals back` |
| F-02 | High | Manual review | **Approving twice.** Without a per-owner record, one owner could call `approve` twice and reach 2 of 3 alone. | `approved[txId][owner]` is checked and set before the count goes up (`AlreadyApproved`). Revoking clears it, so approve → revoke → approve still counts once. | `one owner cannot approve the same proposal twice`, `approve → revoke → approve still counts as one`, fuzz test |
| F-03 | High | Manual review | **Replay.** If a proposal is not marked as done, the same approved payment can be executed again and again until the wallet is empty. | `executed = true` is written **before** the external call (checks → effects → interaction); `AlreadyExecuted` afterwards. Two identical payments are two proposals with their own approvals. | `an executed proposal can never run again`, `two identical payments are two separate proposals…`, `re-running the same proposal from inside its own payment fails` |
| F-04 | High | Manual review | A public `addOwner` / `removeOwner` / `changeThreshold` callable by **one** owner lets that owner add a friend (or drop the threshold to 1) and then spend alone. | These functions only accept calls from the wallet itself (`OnlyWallet`), which means through a proposal with 2 approvals. | `owners cannot change owners or the threshold directly, only through a proposal`, `owners can add an owner and raise the threshold through proposals` |
| F-05 | Medium | Manual review | Lowering the threshold could instantly unlock old proposals that had too few approvals under the old rule. | Covered by the same `configVersion` check as F-01: old proposals become stale and must be proposed again. | `lowering the threshold does not unlock proposals approved under the old rules` |
| F-06 | Medium | Manual review | Removing owners below the threshold (or a threshold above the owner count) would **lock the wallet forever**: no proposal could ever get enough approvals. | `removeOwner` and `changeThreshold` check `threshold ≤ owners`; zero, duplicate and wallet-address owners are rejected; max 10 owners. | `cannot remove owners below the threshold, a stranger, or set a bad threshold`, `rejects zero, duplicate or self owners and a bad threshold`, `cannot grow past 10 owners` |
| F-07 | Low | Manual review | A paid contract could call back into `execute` and run a **second** approved proposal in the middle of the first one, which makes the order of effects hard to reason about. | `nonReentrant` lock on `execute`. | `running a second proposal from inside a payment is blocked by the lock` |
| F-08 | Low | Manual review | A failed call marked as executed would silently lose the payment; ignoring the call result would show "executed" for a payment that never happened. Sending to `address(0)` burns ETH. | A failed call reverts the whole `execute` with `ExecutionFailed(reason)`, so the proposal stays pending; `submit` rejects the zero address. | `a failed call reverts with the reason and the proposal stays pending`, `sending more ETH than the wallet holds fails safely`, `rejects unknown ids and the zero address as target` |
| F-09 | Info | slither (`reentrancy-eth`, `reentrancy-events`) | The first lock was a `bool` reset after the call, and `Executed` was emitted after the call. | Lock rewritten as a `nonReentrant` modifier; the event is emitted before the call (it is rolled back if the call fails). | `pays only after 2 approvals and emits every step`, `can call another contract with data` |
| F-10 | Info | slither (`costly-loop`) | `removeOwner` did `pop()` inside the search loop. | Find the index first, then swap with the last owner and `pop()` once. | `a removed owner loses all power at once` |
| F-11 | Info | slither / solhint | Noise from the test-only helper contracts (`contracts/test/`). | Excluded from slither (`slither.config.json`) and one solhint rule disabled in that file only. | — |

No high or medium issues remain open.

## Known issues (by design, documented)

| ID | Description | Why it is accepted today |
|----|-------------|--------------------------|
| K-01 | **Any owner change cancels every pending proposal.** After adding or removing an owner, open proposals must be submitted and approved again. | This is the price of F-01/F-05. It is simple and safe; real wallets like Safe use a similar idea (a nonce in every signature). |
| K-02 | **The proposed call can do anything**, including calling a malicious contract. | That is what a wallet is for. The protection is that 2 humans must approve the exact `to`, `value` and `data`; `getTransaction` shows all three before approving. |
| K-03 | Approvals are on-chain transactions, so each approval costs gas. | Off-chain signatures (EIP-712) are cheaper but add signature replay risks; they come later in the challenge (Day 24–25). |
| K-04 | No expiry: an approved but unexecuted proposal stays valid until owners revoke it or change the owner set. | Any owner can revoke their approval at any time; an expiry date can be added later if needed. |

## Final green run

```
  MultiSigWallet
    setup
      ✔ stores 3 owners and a threshold of 2 (431ms)
      ✔ rejects zero, duplicate or self owners and a bad threshold (120ms)
      ✔ accepts ETH from anyone and emits Deposit
    a 2-of-3 payment
      ✔ pays only after 2 approvals and emits every step
      ✔ can call another contract with data
      ✔ a failed call reverts with the reason and the proposal stays pending
      ✔ sending more ETH than the wallet holds fails safely
      ✔ rejects unknown ids and the zero address as target
      ✔ revoke takes an approval back
    security: strangers
      ✔ a non-owner cannot submit, approve, revoke or execute
      ✔ owners cannot change owners or the threshold directly, only through a proposal
    security: approving twice
      ✔ one owner cannot approve the same proposal twice
      ✔ approve → revoke → approve still counts as one
    security: replay
      ✔ an executed proposal can never run again
      ✔ two identical payments are two separate proposals with separate approvals
      ✔ re-running the same proposal from inside its own payment fails (executed is set first) (48ms)
      ✔ running a second proposal from inside a payment is blocked by the lock
    security: removed owners and owner changes
      ✔ owners can add an owner and raise the threshold through proposals
      ✔ a removed owner loses all power at once
      ✔ an approval from a removed owner cannot be used to move money
      ✔ a removed and re-added owner does not get old approvals back
      ✔ lowering the threshold does not unlock proposals approved under the old rules
      ✔ cannot remove owners below the threshold, a stranger, or set a bad threshold (51ms)
    limits
      ✔ cannot grow past 10 owners
    fuzz: random approvals, revokes and executes
      ✔ money moves only with 2 current approvals and each proposal pays at most once (50 random runs) (1575ms)


  25 passing (2s)
```

| Tool | Result |
|------|--------|
| `npm audit --omit=dev` | found 0 vulnerabilities |
| `solhint` (recommended) | 0 warnings, 0 errors |
| `slither` (102 detectors) | 0 results (after fixing F-09 and F-10; test helpers excluded, F-11) |
