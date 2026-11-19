# Day 20 — QA and security review

**Contracts:** `contracts/YieldVault.sol` (Himal Yield HUSD, an ERC-4626 vault built on OpenZeppelin 5.0.2 with virtual shares, its own bookkeeping, a profit lock and slippage-checked helpers), `contracts/HimalSavings.sol` (the strategy the vault invests in: only the vault moves money, anyone can pay interest, the deployer can simulate a default), `contracts/HimalToken.sol` (HUSD) · **Vulnerable on purpose, for the lesson:** `contracts/naive/NaiveVault.sol` (the textbook vault: balance-based, no virtual shares, no 0-share check) · **Test helper:** `contracts/test/RoundTrip.sol` (deposit + redeem in one transaction) · **Security focus:** the first-depositor inflation attack

## How it was checked

1. Unit tests (`npx hardhat test`): 1,000,000 shares per HUSD for the first depositor (6 virtual decimals) and an exact round trip; `invest()` keeps 10% as cash; withdrawals bring the rest back from the strategy and update the books; `previewMint` / `previewWithdraw` round up (in the vault's favour); zero amounts refused; redeeming for someone else needs an allowance; only the vault can move strategy money; the vault is connected once; bad constructor inputs refused.
2. Profit tests: 400 HUSD of interest is shared exactly 1 : 3 (Ram 1,100, Sita 3,300), not counted before a harvest, half unlocked after 3 hours, all after 6; a loss counts at once and first eats locked profit; harvest with nothing new does not touch the clock.
3. Attack-style tests:
   - **Inflation attack, naive vault:** 1 wei deposit + 1,000 HUSD sent straight to the vault. Ram's 1,000 HUSD deposit gets **0 shares**; the attacker redeems his 1 share for **all 2,000 HUSD**.
   - **Same attack, safe vault:** the donation is ignored (`totalAssets` stays 1 wei). Ram's deposit is worth exactly 1,000 HUSD; the attacker loses the 1,000.
   - **Stronger attack, safe vault:** the donation goes through the strategy as "interest", is harvested and the attacker waits 6 hours. Virtual shares still protect Ram: he loses **0.00025 HUSD**, the attacker loses **500 HUSD**.
   - **Profit sniping:** Hari deposits 100,000 HUSD just before a 400 HUSD harvest and leaves right after. Without a lock he takes **384.62 HUSD (96%)**; with the 6-hour lock **0.0178 HUSD**.
   - **Unlock griefing:** 1 wei of "interest" and a harvest every 10 minutes for almost 6 hours cannot hold the real profit back.
   - **Exit after a loss:** a 25% default counts before anyone calls `harvest()`, so the first to run gets 750 per 1,000, the same as everyone else.
   - **Slippage:** `depositWithMin` / `redeemWithMin` revert when the price moves against the user.
4. Fuzz tests with **fast-check**: 40 random runs of up to 25 actions by three users: deposits and redeems of dust (1–1,000 wei) or real sizes, withdrawals up to `maxWithdraw`, same-transaction round trips, invest, interest, harvest, losses up to 60%, direct donations and time jumps of up to 8 hours. After **every** action: the vault never claims more HUSD than it holds; its cash count is never above its balance; shares add up to `totalSupply`; everyone's `maxWithdraw` together is at most `totalAssets`; **without a loss the share price never falls**; a same-transaction round trip never makes money; redeems pay at least their quote. At the end everyone can leave. Also run with 400 runs (`npm run fuzz`): green.
5. Mutation check (`npm run mutate`): 14 important lines broken on purpose, one at a time (no virtual shares, cash read from the balance, no profit lock, griefable clock, unharvested profit counted, losses ignored, loss not eating locked profit, no cash buffer, clock restarted on empty harvests, strategy withdrawals not booked, both slippage limits removed, strategy open to anyone, vault replaceable). The tests caught all 14.
6. `npm audit --omit=dev`, `solhint` (recommended rules), `slither`.
7. Manual review like an attacker: who can change the share price and how fast (donations, interest, losses, time); rounding direction in every conversion; what an empty vault with leftover profit does; whether anyone can trap or delay other people's money; re-entrancy through the strategy.

## Findings

F-01 to F-04 came from the attacker review of the design before the first build (each written as a test and each fix also proven by a mutation). F-05 was found in review round 1 after the first build: its test failed (144.5 HUSD still locked) before the fix. F-06 and F-07 came from slither and the fuzz test in round 2.

| ID | Severity | Found by | Description | Fix | Proving test |
|----|----------|----------|-------------|-----|--------------|
| F-01 | High | Design review | **First-depositor inflation attack.** In a vault where shares = assets × supply ÷ balance, an attacker deposits 1 wei, then sends 1,000 HUSD straight to the vault. The next deposit of 1,000 HUSD rounds down to **0 shares**, and the attacker redeems his 1 share for both deposits. | (1) **Virtual shares:** `_decimalsOffset() = 6`, so the vault acts as if 1,000,000 shares and 1 wei always exist; inflating the price means giving most of the donation to those virtual shares. (2) **Own bookkeeping:** the vault counts its cash in `idle`, so tokens sent straight to it are ignored. (3) Deposits that would give 0 shares are refused (`ZeroShares`). | `INFLATION ATTACK on the naive vault…`, `the same attack on YieldVault: the donation is ignored… (F-01)`, `donating through the strategy instead… (F-01)`, mutations "no virtual shares", "cash read from the raw token balance" |
| F-02 | High | Design review | **Profit sniping.** If a harvest raises the share price at once, anyone can deposit just before it and redeem just after, taking profit that long-term depositors waited for. With no lock, Hari took **384.62 of 400 HUSD (96%)** in one block. | Harvested profit is **locked** and unlocks in a straight line over `profitUnlockTime` (6 hours); profit the strategy has not reported yet is not counted at all. Hari's gain with the lock: **0.0178 HUSD**. | `PROFIT SNIPING… (F-02)`, `shares 400 HUSD of interest 1 : 3, unlocked over 6 hours`, mutations "no profit lock", "unharvested profit counted at once" |
| F-03 | Medium | Design review | **Exiting at the old price after a loss.** If a loss only counts when someone calls `harvest()`, people who see the default first can redeem at the old price and leave the whole loss to everyone else (a bank run). | `totalAssets()` reads the strategy live and takes **the lower** of the live value and the books: losses count at once (first eating locked profit, exactly like `harvest` will), gains only after a harvest. Harvesting a loss does not move the price again. | `cannot exit at the old price after a loss… (F-03)`, `a loss counts at once and first eats the profit that is still locked`, mutations "losses ignored until a harvest", "a loss does not eat locked profit" |
| F-04 | Medium | Design review | **No slippage limit in ERC-4626.** `deposit` and `redeem` accept whatever price there is when the transaction lands; a loss or a front-run in between changes what the user gets. | `depositWithMin(assets, receiver, minShares)` and `redeemWithMin(shares, receiver, owner, minAssets)` revert with `TooFewShares` / `TooFewAssets` (the EIP-5143 idea). The plain ERC-4626 functions stay for compatibility. | `depositWithMin / redeemWithMin protect against a price that moved (F-04)`, mutations "depositWithMin has no limit", "redeemWithMin has no limit" |
| F-05 | Medium | Review round 1 | **Unlock griefing.** The first build restarted the full 6-hour clock on every harvest with new profit. `payInterest` and `harvest` are open to anyone, so paying 1 wei and harvesting every 10 minutes turned the straight-line unlock into a slow fade: after 6 hours **144.5 of 400 HUSD** was still locked. | The new end time is the **average** of the old remaining time and a full unlock time, **weighted by amount** (rounded up, so profit never unlocks early). A 1-wei profit barely moves it. Harvests with nothing new return early and leave the clock alone. | `UNLOCK GRIEFING… (F-05)`, `harvest with nothing new does not restart the unlock clock`, mutations "harvest restarts the full unlock clock", "harvest with nothing new restarts the clock" |
| F-06 | Low | slither, round 2 | **State written after an external call.** `_withdraw` called `strategy.withdraw` before updating `idle` (`reentrancy-no-eth`). The strategy is fixed and trusted and every entry point is `nonReentrant`, so it was not exploitable, but it broke checks → effects → interactions. | The books (`idle`, `strategyAssets`) are written first, then the strategy is called, then the shares are burned and HUSD sent. | `invest() keeps 10% as cash, and withdrawals bring the rest back…`, fuzz invariants, mutation "withdrawal forgets money left the strategy" |
| F-07 | Low | Fuzz test, round 2 | **Test oracle fix, not a contract bug.** The fuzz first deposited and redeemed in two transactions and saw a 0.00005 HUSD gain: real profit unlocking during the 1 second between them. The property that matters is "no free money in **one** transaction". | `RoundTrip` deposits and redeems in a single transaction; the fuzz checks it never returns more than was put in. Expectations for dust (≤ 1,000 wei) deposits allow a refusal when the price rises by the next block. | fuzz "a same-block round trip never makes money" |

Also checked and fine: every conversion rounds in the vault's favour (deposit and redeem round down, mint and withdraw round up); `lockedProfit()` can never be more than the books hold, so `totalAssets()` cannot underflow (fuzz: 400 runs); a strategy withdrawal can never be bigger than the strategy holds, because payouts are capped by `totalAssets()`; the vault has **no owner and no admin functions**; the strategy's vault is set once and only the vault can move its money; the vault and the strategy both ignore tokens sent to them directly.

`slither` reported 0 results. The vulnerable-on-purpose `NaiveVault` and the test helper are excluded in `slither.config.json`, as is the `timestamp` detector (the profit lock must use `block.timestamp`). Reviewed and silenced inline with a reason: `incorrect-equality` on zero checks and on the vault's own bookkeeping (not token balances), and `dead-code` on `_deposit` / `_withdraw` (they are overrides that OpenZeppelin's `deposit` / `withdraw` call).

No high or medium issues remain open.

## Known issues (by design, documented)

- **Virtual shares keep a little dust.** The 1,000,000 virtual shares own a tiny part of every profit (and most of any donation to an empty vault). In the demo that is under 0.000001 HUSD per user.
- **A trusted strategy.** `HimalSavings` is fixed at deployment and trusted; a malicious strategy could lie in `totalAssets()`. Real vaults (Yearn v3) add strategy limits, health checks and a manager.
- **Profit still drips to anyone holding shares,** second by second. Holding for one block after a harvest earns about 1/21,600 of the profit, which is fair: you held shares for that second.
- **Withdrawals need the strategy to pay.** If the strategy is frozen, only the 10% cash can leave. Real vaults add queues and emergency exits.
- **No fees.** Real vaults take a performance and management fee, usually by minting shares to a treasury.
- **Fee-on-transfer or rebasing tokens are not supported.** The vault books exactly the amount it asked to receive; HUSD is a plain ERC-20.
- **`NaiveVault` is vulnerable on purpose**, kept only to prove the attack. Never deploy it.

## Final run

```
18 passing
  Fuzz: 40 random runs of up to 25 actions (solvent, shares add up, price never falls without a loss, no same-block profit, everyone can leave)
  Extra: FUZZ_RUNS=400 → 1 passing
npm audit --omit=dev: found 0 vulnerabilities
solhint: 0 warnings, 0 errors
slither: 20 contracts analyzed, 0 results
mutation check: 14 of 14 broken versions caught
```
