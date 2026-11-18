# Day 19 — QA and security review

**Contracts:** `contracts/DollarEngine.sol` (vaults, minting, liquidation, price checks), `contracts/EverestDollar.sol` (EUSD, minted and burned only by the engine), `contracts/EthUsdFeed.sol` (Chainlink-shaped ETH/USD feed with a `minAnswer` / `maxAnswer` band that clamps, like real aggregators) · **Vulnerable on purpose, for the lesson:** `contracts/naive/NaiveDollarEngine.sol` (the same engine, but it believes any price) · **Test helpers:** `contracts/test/` (`BrokenFeed` returns any round data, `ReentrantVault` calls back into the engine or refuses ETH, `ForceSend` pushes ETH in with `selfdestruct`) · **Security focus:** stale prices, depeg

## How it was checked

1. Unit tests (`npx hardhat test`): the 150% limit to the cent (13,333.33 EUSD on 10 ETH at $2,000 works, 13,333.34 does not), a full mint → withdraw → repay → exit round trip, the 100 EUSD minimum debt, the debt ceiling, zero amounts, plain ETH refused, only the engine can mint or burn EUSD, feeds with 6 decimals, bad feeds refused at deployment.
2. Liquidation tests: a healthy vault (exactly 150%) cannot be liquidated; at $1,700 half the debt buys exactly that value + 10% in ETH; at $1,000 the vault must close in one go and the shortfall becomes visible bad debt; at 104% the liquidator must repay the whole debt; a liquidator that refuses ETH only blocks itself; re-entering `withdraw`, `mint` or `liquidate` from an ETH transfer is blocked.
3. Attack-style tests:
   - **Stale price:** the feed stops for 2 hours while ETH really halves. The naive engine mints 13,333.33 EUSD on 10 ETH now worth $10,000, so each coin is backed by **$0.75**. The safe engine refuses with `StalePrice`.
   - **Clamped price (LUNA):** ETH trades at $300 but the feed reports its $500 floor. The naive engine mints 33,333.33 EUSD on 100 ETH worth $30,000 (**$0.90** per coin). The safe engine refuses with `PriceOutOfBounds`.
   - **Broken rounds:** future timestamp, no timestamp, unfinished round, zero and negative prices.
   - **Depeg check:** after a 25% crash, liquidations bring the riskiest vault back above 150% and the system stays over-backed with no bad debt.
   - **Fake backing:** 90 ETH force-sent with `selfdestruct` does not change `backing()`.
4. Fuzz tests with **fast-check**: 40 random runs of up to 20 actions by three vault owners and a liquidator: price moves ($700 to $3,000), 1-hour-plus time jumps, deposits, mints, repays, withdrawals and liquidations of random sizes. A JavaScript copy of the maths predicts whether each action **must** succeed, and the test fails if the contract disagrees. After a liquidation: the exact ETH seized, never more than repay + 10% in value, and bad debt **only** when the ETH was worth less than the debt. After every run: `totalDebt` = sum of vault debts, EUSD supply = debts + bad debt, `totalCollateral` = sum of vault ETH = the engine's balance. Also run with 400 runs (`npm run fuzz`), which also requires every action to have both succeeded and been refused: green.
5. Mutation check (`npm run mutate`): 19 important lines broken on purpose, one at a time: no 150% check on mint or on withdraw, old prices, future prices, band ignored, unfinished rounds, healthy vaults liquidatable, no close factor, a 20% bonus, a small repay allowed under 110%, ETH left behind under 110%, bad debt hidden, no debt ceiling, dust debt, `mint` or `withdraw` not `nonReentrant`, repay that burns nothing, backing read from the raw balance, anyone can mint EUSD. The tests caught all 19.
6. `npm audit --omit=dev`, `solhint` (recommended rules), `slither`.
7. Manual review like an attacker: what happens when the price is old, wrong, clamped or missing; who can block a liquidation; whether a liquidator can profit at the system's expense; rounding direction; re-entrancy through ETH transfers; force-sent ETH; dust vaults; unbounded minting.

## Findings

F-01 to F-04 and F-07 came from the attacker review of the design before the first build (each written as a test, and each fix also proven by a mutation). F-05 was found by the tests and the demo in round 1, F-06 in review round 2.

| ID | Severity | Found by | Description | Fix | Proving test |
|----|----------|----------|-------------|-----|--------------|
| F-01 | High | Design review | **Minting on a stale price breaks the peg.** If the feed stops updating during a crash, an engine that reads `answer` alone keeps valuing ETH at yesterday's $2,000. In the test, 10 ETH really worth $10,000 minted 13,333.33 EUSD: **$0.75** of ETH behind each coin. | `_price()` refuses any answer more than **1 hour** old (`StalePrice`). Mint, liquidate and withdraw-with-debt need a fresh price. | `STALE-PRICE ATTACK on the naive engine… (F-01)`, `a price older than 1 hour stops mint…`, mutation "old prices accepted" |
| F-02 | High | Design review | **A feed stuck on its floor reports a price that is too high (the LUNA lesson).** Chainlink-style feeds clamp answers to `[minAnswer, maxAnswer]`. With ETH at $300 the feed still says $500, and fresh timestamps pass any age check. The naive engine minted 33,333.33 EUSD on $30,000 of ETH (**$0.90** per coin). | The engine reads the feed's band at deployment and refuses any answer **on or outside** it (`PriceOutOfBounds`), at the floor and at the ceiling. | `CLAMPED-PRICE ATTACK (the LUNA lesson)… (F-02)`, mutation "circuit-breaker band ignored" |
| F-03 | Medium | Design review | **Broken rounds.** A feed can return a timestamp in the future, a 0 timestamp, an unfinished round (`answeredInRound < roundId`), or a 0 / negative answer; casting a negative `int256` to `uint256` gives a gigantic price. Feeds with other decimals would be mis-scaled. | All refused in `_price()`; the band check runs before the cast. Decimals are read at deployment and scaled to 18; feeds with more than 18 decimals, a bad band or a 0 debt ceiling are refused (`BadFeed`). | `refuses prices from the future, with no timestamp, from an unfinished round, or zero (F-03)`, `reads feeds with other decimals correctly…`, mutations "prices from the future accepted", "unfinished rounds accepted" |
| F-04 | Medium | Design review | **A price outage must not trap people or hide risk.** If every action needed a price, nobody could repay or add ETH during an outage, exactly when vaults most need saving; and liquidating on a broken price would either seize healthy vaults (too low) or let bad debt grow (too high). | Deposit, repay and withdraw-with-no-debt never read the price. Mint, liquidate and withdraw-with-debt refuse a broken price. Liquidation never pays the vault owner, so an owner whose `receive()` reverts cannot block it. | `a price older than 1 hour stops mint… but never deposit, repay or a debt-free exit`, `a liquidator that refuses ETH only blocks itself…`, `DEPEG CHECK: after a 25% crash… (F-04)` |
| F-05 | Medium | Tests + demo, round 1 | **Avoidable bad debt from liquidators.** The first build allowed a full close under 110% for *any* amount up to the debt, capped at all the ETH. At 104% (12,500 of ETH, 12,000 debt) a liquidator could repay 11,363.64, take all the ETH with the full 10% bonus and leave **636 EUSD** of bad debt in a vault that was still solvent. Rounding also left 1 wei of ETH in a closed vault, which would have kept it "alive" and hidden its bad debt. | Under 110% it is **all or nothing**: the liquidator always takes all the ETH and must repay the whole debt if the ETH covers it (the bonus shrinks to what is there), or at least the ETH's value minus 10% (rounded up) if not (`RepayTooSmall`). Above 110%, taking 110% per 100% repaid can never push a vault below 110%. | `at 104% the liquidator must repay the WHOLE debt: no avoidable bad debt (F-05)`, `ETH crashes to $1,000 (83%): the vault closes in one go…`, fuzz "bad debt only when the ETH was worth less than the debt", mutations "closing zone allows a small repay", "closing zone leaves ETH behind", "bad debt hidden" |
| F-06 | Low | Review round 2 | **Fake backing.** `backing()` first used `address(this).balance`. ETH force-sent with `selfdestruct` (which skips `receive()`) would make every EUSD look better backed than it is, misleading anyone who reads it. | The engine counts `totalCollateral` itself; `backing()` uses that. The fuzz checks it equals the sum of all vaults. | `ETH force-sent to the engine cannot make EUSD look better backed (F-06)`, mutation "backing reads the raw ETH balance" |
| F-07 | Low | Design review | **Unbounded and dust minting, re-entrancy.** Tiny vaults cost more gas to liquidate than they pay, so nobody would; an unknown bug could mint without limit; ETH transfers hand control to the receiver. | 100 EUSD minimum debt (`DustDebt`), an immutable `debtCeiling` (`CeilingReached`), every state-changing function `nonReentrant` with state written before the ETH transfer, and EUSD can be minted only by the engine that created it. | `refuses dust debt below 100 EUSD…`, `stops at the debt ceiling`, `re-entering the engine while receiving ETH is blocked…`, `only the engine can mint or burn`, mutations "dust debt allowed", "no debt ceiling", "mint/withdraw not nonReentrant", "anyone can mint EUSD" |

Also checked and fine: a vault at exactly 150% is healthy and cannot be liquidated; the collateral value rounds **down** and seized ETH rounds **down**, so rounding never favours the user; repaying more than you owe or withdrawing more than you have reverts; plain ETH sent to the engine is refused (`UseDeposit`), so it cannot be locked without a vault; the engine has **no owner and no admin functions**; EUSD supply always equals vault debts plus written-off bad debt.

`slither` reported 0 results. The vulnerable-on-purpose `NaiveDollarEngine` and the test helpers are excluded in `slither.config.json`, as is the `timestamp` detector (the price-age check must use `block.timestamp`). Reviewed and silenced inline with a reason: `arbitrary-send-eth` / `low-level-calls` on `_sendEth` (it only ever pays the caller: the vault owner in `withdraw`, the liquidator in `liquidate`) and `unused-return` on `latestRoundData` (`startedAt` is not needed). Slither's `uninitialized-local` note on `written` was fixed by initialising it.

No high or medium issues remain open.

## Known issues (by design, documented)

- **No stability fee or savings rate.** Debt does not grow over time, so nothing pushes the market price back to $1 except liquidations and people's trust in the backing. MakerDAO uses fees and the DSR; Liquity uses redemptions.
- **Bad debt has no backstop.** It is shown openly in `badDebt` and in `backing()`, but no reserve or governance token covers it.
- **Oracle front-running.** A user who sees a falling price update in the mempool can mint or withdraw at the old price first, within the 1-hour window. The 150% buffer absorbs this; Maker delays new prices by an hour (the OSM) to close it.
- **A partial liquidation can leave a vault with less than 100 EUSD of debt.** Only minting and repaying enforce the minimum; blocking it in liquidations could stop small vaults from being liquidated at all.
- **During a feed outage nothing can be liquidated.** That is the safer choice (no seizing on a wrong price), but a long outage during a crash would grow bad debt. A real system adds a backup oracle.
- **`NaiveDollarEngine` is vulnerable on purpose**, kept only to prove the two attacks. Never deploy it.

## Final run

```
19 passing
  Fuzz: 40 random runs of up to 20 actions (model-predicted results, exact seizures, no avoidable bad debt, supply = debts + bad debt)
  Extra: FUZZ_RUNS=400 → 1 passing
npm audit --omit=dev: found 0 vulnerabilities
solhint: 0 warnings, 0 errors
slither: 19 contracts analyzed, 0 results
mutation check: 19 of 19 broken versions caught
```
