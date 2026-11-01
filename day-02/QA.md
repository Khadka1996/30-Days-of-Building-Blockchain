# Day 02 — QA and security review

**Contract:** `contracts/PiggyBank.sol` · **Security focus:** safe withdrawals (checks → effects → interaction)

## How it was checked

1. Unit tests for every function, every error and the exact unlock second (`npx hardhat test`)
2. Attack tests with helper contracts in `contracts/test/`: a **reentrancy attacker**, a **smart-contract wallet** that needs more than 2,300 gas, a wallet that **rejects ETH**, and a **force-send** via `selfdestruct`
3. A fuzz test with **fast-check**: 50 random sequences of deposit / extend / withdraw / time jumps by two users, checked against a simple JavaScript model, plus invariants (`totalLocked` = sum of balances = ETH held)
4. `npm audit --omit=dev`, `solhint` (recommended rules), `slither`
5. Manual review like an attacker: reentrancy, access control, time handling, input validation, ETH accounting, denial of service

## Findings

All findings came from the manual review of the first design, before the first commit. Each one is now guarded by a test.

| ID | Severity | Found by | Description | Fix | Proving test |
|----|----------|----------|-------------|-----|--------------|
| F-01 | High | Manual review | Sending the ETH **before** zeroing the balance lets a malicious contract call `withdraw()` again from its `receive()` and drain other people's savings (the classic reentrancy bug). | **Checks → effects → interaction:** the bank is deleted and `totalLocked` reduced before the ETH is sent. A re-entering call finds a zero balance. | `reentrancy: an attacker calling withdraw() again from receive() gets nothing extra` |
| F-02 | Medium | Manual review | If every deposit could set the unlock date, a second small deposit could move the date **earlier** and defeat the lock. | The date is set only when the bank is empty. Later deposits must pass `0`; `extendLock` can only move the date **later**. | `a second deposit cannot change (or shorten) the date`, `extendLock can never move the date earlier or keep it the same` |
| F-03 | Medium | Manual review | `transfer()` / `send()` forward only 2,300 gas, so smart-contract wallets (multisigs, smart accounts) could never withdraw: funds stuck forever. | Use `call{value: ...}` and **revert** if it fails, so a failed payout never loses the savings. | `smart-contract wallets that need more than 2300 gas can withdraw`, `a failed payout reverts and the savings stay safe` |
| F-04 | Low | Manual review | A timestamp typed in **milliseconds** (a common JavaScript mistake) would lock the ETH for ~50,000 years. | `MAX_LOCK_DURATION = 10 years`; anything later reverts with `LockTooLong`. | `rejects locks longer than 10 years (e.g. a timestamp in milliseconds)` |
| F-05 | Low | Manual review | An unlock date in the past (or right now) would create a "lock" that locks nothing. | The first unlock date must be strictly in the future (`UnlockNotInFuture`). | `rejects an unlock date in the past or right now` |
| F-06 | Low | Manual review | Using `address(this).balance` for accounting breaks when someone force-sends ETH with `selfdestruct` (it cannot be blocked). | Balances are tracked per user plus a separate `totalLocked`; extra ETH is ignored. Plain ETH sent without `deposit()` is rejected. | `force-sent ETH (selfdestruct) does not change anyone's balance`, `rejects plain ETH sent without deposit()` |
| F-07 | Info | slither (`timestamp`) | `block.timestamp` can be nudged by a validator by a few seconds. | Accepted: locks are measured in days, so a few seconds do not matter. Documented in the code. | `refuses one second before the unlock date, works exactly at it` |
| F-08 | Info | slither (`low-level-calls`) | `withdraw()` uses a low-level `call`. | Accepted on purpose (see F-03); the return value is checked and the call happens last. | `a failed payout reverts and the savings stay safe` |
| F-09 | Info | Manual review | There is no admin and no emergency exit. Money added to a bank whose date has already passed is not locked (use `extendLock` to lock it again). | By design: nobody, not even the deployer, can move your savings. Documented in the NatSpec and README. | `Bob cannot take Alice's money, even after her unlock date` |

No high or medium issues remain open.

## Final green run

```
  PiggyBank
    depositing
      ✔ opens a bank with an unlock date and emits Deposited
      ✔ adds more money later with unlockAt = 0 and keeps the date
      ✔ gives every user their own bank
      ✔ rejects a zero deposit
      ✔ rejects plain ETH sent without deposit()
    unlock date rules
      ✔ rejects an unlock date in the past or right now
      ✔ rejects locks longer than 10 years (e.g. a timestamp in milliseconds)
      ✔ a second deposit cannot change (or shorten) the date
      ✔ extendLock moves the date later and emits LockExtended
      ✔ extendLock can never move the date earlier or keep it the same
      ✔ extendLock needs money in the bank and respects the 10-year limit
      ✔ timeLeft counts down to 0
    withdrawing
      ✔ refuses one second before the unlock date, works exactly at it
      ✔ pays out everything, emits Withdrawn and resets the bank for reuse
      ✔ cannot withdraw twice or from an empty bank
    security
      ✔ Bob cannot take Alice's money, even after her unlock date
      ✔ Bob cannot change Alice's unlock date
      ✔ reentrancy: an attacker calling withdraw() again from receive() gets nothing extra
      ✔ smart-contract wallets that need more than 2300 gas can withdraw
      ✔ a failed payout reverts and the savings stay safe
      ✔ force-sent ETH (selfdestruct) does not change anyone's balance
    fuzz: random deposits, extensions, withdrawals and time jumps
      ✔ balances, totalLocked and ETH held always match a simple model (50 random runs)


  22 passing (3s)
```

| Tool | Result |
|------|--------|
| `npm audit --omit=dev` | found 0 vulnerabilities |
| `solhint` (recommended) | 0 warnings, 0 errors |
| `slither` (102 detectors, test helpers excluded) | 4 informational results: 3 × `timestamp`, 1 × `low-level-calls`, both accepted above (F-07, F-08) |
