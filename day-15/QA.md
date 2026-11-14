# Day 15 — QA and security review

**Contracts:** `contracts/HimalStaking.sol` (the staking pool), `contracts/HimalToken.sol` (HIM to stake, HRW as rewards) · **Test helpers:** `contracts/test/` (`NaiveLumpStaking`, `ClassicStaking`, `SixDecimalToken`, `FeeToken`, `HookToken`, `ReentrantStaker`) · **Security focus:** reward rounding, staking just before payout

## How it was checked

1. Unit tests (`npx hardhat test`): one staker for the full week, two stakers with different amounts joining at different times, rewards stopping at the end of the period, topping up mid-period, `exit()`, claiming twice, withdrawing after the owner renounces, every input check and every owner-only function.
2. Attack-style tests with hostile or broken contracts:
   - `NaiveLumpStaking` pays each reward deposit out at once. The test shows an attacker who stakes just before the deposit and leaves straight after really takes 90% of it.
   - `ClassicStaking` is the common streaming formula with an unscaled reward rate and no handling of empty periods. The tests show it really loses 100% of a small reward, 5.4% of a normal one, and 1 day of rewards when nobody is staked.
   - `SixDecimalToken` (like USDC) as the reward token, to make rounding visible.
   - `FeeToken` burns 1% on every transfer; `HookToken` + `ReentrantStaker` try to withdraw the same stake twice from inside a transfer hook.
   - An attacker calling `getReward()` 200 times to round other people's rewards away.
3. Fuzz tests with **fast-check**:
   - 40 random runs of up to 18 actions (stake / withdraw / claim / add rewards / wait, by 3 stakers). After every action the contract must match an exact JavaScript copy of the maths (`test/helpers.js`), wei for wei, and the pool must hold enough HRW to pay everything it owes. Also run once with 400 runs (`FUZZ_RUNS=400 npx hardhat test test/Fuzz.test.js`): green.
   - 30 random weeks with two stakers (any amount, any reward, the second one joining at any second): everything is paid out except at most 5 wei.
4. Mutation check: 11 key lines were broken on purpose, one at a time (1e18 instead of 1e36, empty-period rewards dropped, stake credits `amount` instead of what arrived, `nonReentrant` removed, `onlyOwner` removed, owner allowed to recover HRW, reward not pulled in, leftover not carried over, new staker not settled before staking, rewards flowing after the period, same token allowed). The tests caught all 11.
5. `npm audit --omit=dev`, `solhint` (recommended rules), `slither`.
6. Manual review like an attacker: just-in-time staking, rounding and precision griefing, unfunded promises, owner rug pulls, odd tokens (fee, hooks, 6 decimals), re-entrancy, stuck funds, overflow, input validation.

## Findings

F-01 to F-06 came from the attacker review of the design before the first build (each one is written as a test that fails on the naive or classic version). F-07 was found by the tests on the first build.

| ID | Severity | Found by | Description | Fix | Proving test |
|----|----------|----------|-------------|-----|--------------|
| F-01 | Medium | Design review | **Reward rate rounds down.** The classic formula stores `rewardRate = reward / duration` as a whole number. 1 USD6 over 30 days gives a rate of 0, so stakers get nothing; 100 USD6 over a year gives 3 instead of 3.17 per second, so 5.39 USD6 (5.4%) is stuck in the contract forever. | The rate is stored multiplied by `PRECISION` (`rewardRateScaled`), so the remainder is kept. Both cases now pay out in full (99.999999 of 100 USD6). | `CLASSIC: 1 USD6 over 30 days rounds to 0…`, `CLASSIC: 100 USD6 over a year loses 5.39 USD6…`, `HIMAL: the same two rewards are paid out in full` |
| F-02 | High | Design review | **Staking just before the payout.** If a reward deposit is shared out at once to whoever is staked at that moment, an attacker who sees it coming stakes just before, claims and leaves. In the naive pool the attacker took 9,000 of 10,000 HRW; Ram, staked for 30 days, got 1,000. | Rewards stream per second over the period, and every stake, withdraw and claim first settles the account at the current reward-per-token. Joining just before the payout earns only the seconds you are really staked: 0.10 HRW of 70,000. | `NAIVE (lump-sum) pool…takes 90% of it`, `HIMAL pool: the same attacker…gets only ~1 second of rewards`, `staking before the period but leaving early earns nothing extra later`, mutation "new staker not settled" |
| F-03 | Medium | Design review | **Rewards for empty seconds are lost.** In the classic formula, time keeps moving even when nobody is staked, so those seconds pay out to nobody. With a 7,000 USD6 week and the first staker arriving after 1 day, 1,000 USD6 was stuck with no way out. | While `totalStaked == 0`, those rewards go into `unallocatedScaled` and are added to the next `notifyRewardAmount` period. | `CLASSIC: rewards for days nobody was staked are stuck forever`, `HIMAL: …roll into the next period` (14,000 of 14,000 paid) |
| F-04 | Medium | Design review | **Fee-on-transfer tokens break the books.** If `stake(1000)` credits 1,000 but only 990 arrives, the pool owes more than it holds and the last person to withdraw cannot. The same applies to a reward deposit (the rate would promise tokens that never arrived). | `_pull` measures the balance before and after and credits only what arrived, for both stakes and reward deposits. | `a fee-on-transfer token: you are credited what arrived…`, `a fee-on-transfer reward token: the rate is set from what really arrived` |
| F-05 | Medium | Design review | **Owner rug pull and mixed-up tokens.** A `recoverERC20` that allows the staking or reward token lets the owner take stakers' money or promised rewards. If staking and reward token are the same, rewards can be paid out of other people's stakes. Unfunded promises: if the owner can set a rate without depositing, the pool can owe tokens it never had. | `recoverERC20` refuses HIM and HRW; the constructor refuses the same token twice; `notifyRewardAmount` pulls the tokens in before setting the rate. Withdraw has no pause and no owner check, so stakers can always leave. | `the owner can rescue stray tokens but never the staked HIM or the HRW rewards`, `rejects…using the same token`, `rewards are pulled in first…`, `stakers can always withdraw, even if the owner walks away` |
| F-06 | Medium | Design review | **Re-entrancy through token hooks.** A token that calls the receiver on transfer (like ERC-777) lets an attacker call `withdraw` again before the first one finishes. | `nonReentrant` on every external function that moves tokens, and balances are updated before the transfer (checks → effects → interaction). | `a token with transfer hooks cannot be used to withdraw the same stake twice` (fails with `ReentrancyGuardReentrantCall`), mutation "nonReentrant removed" |
| F-07 | Medium | Tests on build 1 | **Precision too small for reward-per-token.** Build 1 used the usual `1e18` scale. Each update of `rewardPerToken` then loses up to `totalStaked / 1e18` reward units. With a 6-decimal reward token and only 1,000 HIM staked, Ram got 0.999 instead of 1 USD6, and an attacker who called `getReward()` 200 times over a month wiped out **20%** of everyone's rewards (8 of 10 USD6 paid). | `PRECISION` is now `1e36`. The loss per update is below 1 unit for any total stake up to 10¹⁸ tokens. After the fix, Ram (who never touched the pool) gets his full 5 USD6 even with 200 pokes; the poker only loses less than 1 unit per claim of her own reward, because tokens cannot be paid in fractions of a unit. Overflow is checked by Solidity and only possible for rewards above 10⁴¹ units (the call would revert, nothing is lost). | `HIMAL: an attacker poking the pool 200 times cannot round anyone's rewards away (F-07)`, `HIMAL: the same two rewards are paid out in full`, fuzz "40 random runs" (exact model match), mutation "1e18 precision" |

Also checked and fine: rewards stop exactly at `periodFinish`; topping up mid-period carries the unpaid part over (105,000 of 105,000 paid); claiming twice pays nothing the second time; `exit()` with nothing staked does not revert; zero amounts and withdrawing more than you staked revert; durations outside 1–365 days are refused; only the owner can add rewards (anyone being able to would let a griefer stretch the period with a 1-wei reward).

`slither` reported 0 results on the main contracts (OpenZeppelin and test helpers are excluded in `slither.config.json`; `timestamp` is excluded because rewards are time-based by design). Two detectors were reviewed and silenced inline with a comment: `divide-before-multiply` on the leftover carry-over (the rounding is below 10⁻³⁶ of a unit per second at 1e36 scale) and `incorrect-equality` on `== 0` checks of the contract's own totals and of the amount that arrived (neither can be manipulated into a harmful state).

No high or medium issues remain open.

## Known issues (by design, documented)

- **The owner is trusted to set fair periods.** The owner can top up with a tiny reward and a long duration, which lowers the rate for the rest of the period (nothing already earned is lost). Only the owner can call `notifyRewardAmount`, so outsiders cannot do this. A real protocol puts this behind a DAO and timelock (Day 14).
- **Unallocated rewards wait for the next period.** Rewards for empty seconds are only paid out after the owner calls `notifyRewardAmount` again. If the owner never does, they stay in the contract (they are tracked in `unallocatedScaled`, not lost from the books).
- **No lock-up.** Stakers can withdraw at any time; that is what makes the per-second maths fair. A real protocol may add a lock-up or a cooldown.
- **Rebasing tokens are not supported.** A token whose balances change by themselves (like stETH) would break the totals. Use a wrapped, non-rebasing version.
- **Rounding dust.** Each claim pays whole units only, so a claimer can lose less than 1 unit (1 wei) per claim. Over a full week with two stakers, at most 5 wei is left over (fuzz-tested).

## Final run

```
25 passing
  Fuzz: 40 random runs of up to 18 actions each (exact model match, solvent after every step)
  Fuzz: 30 random two-staker weeks (at most 5 wei of dust)
  Extra: FUZZ_RUNS=400 → 2 passing
npm audit --omit=dev: found 0 vulnerabilities
solhint: 0 warnings, 0 errors
slither: 23 contracts analyzed, 0 results
mutation check: 11 of 11 broken versions caught
```
