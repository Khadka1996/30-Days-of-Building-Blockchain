# Day 16 — QA and security review

**Contracts:** `contracts/HimalLend.sol` (the lending pool), `contracts/HimalPriceFeed.sol` (a Chainlink-shaped price feed), `contracts/HimalToken.sol` (HUSD to lend, HIM as collateral) · **Test helpers:** `contracts/test/` (`MiniPair` swap pool, `NaiveSpotLending`, `FeeToken`, `SixDecimalToken`) · **Security focus:** bad debt, price manipulation

## How it was checked

1. Unit tests (`npx hardhat test`): lending and redeeming, borrowing exactly up to 75% LTV and not 1 wei more, withdrawing collateral with and without debt, the kinked interest model at 0 / 40 / 80 / 90 / 100% utilisation, a full year of interest split 90% lenders / 10% reserves, partial liquidation at $8.50, full liquidation and write-off at $6, every input check and every owner-only function.
2. Attack-style tests:
   - `NaiveSpotLending` values collateral at a swap pool's spot price. The test shows an attacker really pumping HIM from $1 to ~$16 with one trade, borrowing all 50,000 HUSD against 4,200 HIM and keeping over 40,000 HUSD profit. The same trade against Himal Lend is refused (max 3,150).
   - Stale (over 1 hour), zero and negative prices; donating HUSD straight to the pool; borrowing 1 wei 50 times; a fee-on-transfer token; a 6-decimal token paired with an 18-decimal one.
3. Fuzz tests with **fast-check**: 40 random runs of up to 25 actions (lend / redeem / lock / unlock / borrow / repay / liquidate / wait up to 60 days / move the price between $2 and $20, by 2 lenders and 2 borrowers). After every action: the pool's HUSD and HIM balances equal its books, total debt equals the sum of every borrower's debt (within 1 wei each), reserves never exceed cash + debt, no Solidity panic, and a successful borrow or collateral withdrawal always leaves the borrower within 75% LTV. At the end every borrower repays, every lender redeems every share, and only the reserves (plus under 1,000 wei) are left. Also run once with 400 runs (`FUZZ_RUNS=400 npx hardhat test test/Fuzz.test.js`): green.
4. Mutation check: 14 key lines were broken on purpose, one at a time (debt rounds down, no staleness check, no zero-price check, no write-off, reserves do not absorb the loss, LTV check removed from borrow, LTV check removed from withdrawCollateral, close factor ignored, healthy loans liquidatable, no accrual before repay, no reserve cut, fee token accepted, cash not tracked on repay, owner can take more than the reserves). The tests caught all 14.
5. `npm audit --omit=dev`, `solhint` (recommended rules), `slither`.
6. Manual review like an attacker: oracle manipulation, stale and broken prices, bad debt and who pays for it, over-liquidation, rounding, interest accrued late, share-price manipulation, odd tokens, re-entrancy, owner powers, stuck funds.

## Findings

F-01 to F-05, F-07 and F-08 came from the attacker review of the design before the first build (each is written as a test, and each fix is also proven by a mutation). F-06 was found in review round 2, after the first build was green.

| ID | Severity | Found by | Description | Fix | Proving test |
|----|----------|----------|-------------|-----|--------------|
| F-01 | High | Design review | **Price manipulation.** A pool that values collateral at a swap pool's spot price believes whatever the last trade says. With one 30,000 HUSD trade the attacker pushed HIM from $1.00 to $15.96, borrowed all 50,000 HUSD against 4,200 HIM ($4,200 of real value), sold the rest back and kept 42,690 HUSD profit. The pool was left with 50,000 of debt it can never collect. | Collateral is valued only by a Chainlink-shaped price feed (`HimalPriceFeed`), which no trade can move. | `NAIVE pool priced by a swap pool's spot price…(F-01)`, `HIMAL pool, same trade…only 75% of the real value` (borrow 50,000 reverts, max 3,150) |
| F-02 | Medium | Design review | **Stale or broken prices.** If the feed stops updating while HIM falls, the pool keeps lending against the old, higher price. A price of 0 or below would make every loan look worthless (or break the maths). | `_price()` refuses a price that is zero or negative, from the future, or older than 1 hour. Repaying, lending and withdrawing collateral with no debt never need a price, so a broken feed cannot trap anyone's money. | `refuses a price older than 1 hour, zero or negative, but still lets people repay and lend (F-02)`, `with no debt you can always take your collateral back, even if the price feed is stale`, mutations "no staleness check", "no zero-price check" |
| F-03 | High | Design review | **Hidden bad debt.** When collateral is worth less than the debt, no liquidator will close the whole loan, and the debt stays in the books forever. The pool keeps counting money it will never get, so the first lenders to leave get full value and the **last lender finds an empty pool**. | If the collateral cannot cover the debt plus the bonus, the whole debt can be closed in one liquidation. When a borrower has no collateral left but still owes, the rest is written off at once: **reserves pay first, then every lender's share loses the same value**. `BadDebtWrittenOff` makes it public. | `price crashes to $6: the whole debt is closed, the loss is written off, reserves first, then lenders equally (F-03)`, `liquidating an underwater loan in small steps still ends with no debt left hiding in the books`, mutations "no write-off", "reserves do not absorb the loss" |
| F-04 | Medium | Design review | **Over-liquidation.** If a liquidator may repay the whole debt of a borrower who is only slightly unhealthy, they take a 5% bonus on everything, and a borrower who was 1% over the line loses far more collateral than needed. Liquidating healthy loans would be outright theft. | A loan is liquidatable only when debt > 80% of collateral value. Each liquidation may close at most 50% of the debt (the *close factor*), unless the loan is underwater (F-03). The bonus is a fixed 5%, and the seized amount rounds down. | `a healthy borrower cannot be liquidated`, `price falls to $8.50: a liquidator repays at most half the debt…` (health factor 0.921 → 1.002, a second liquidation reverts), mutations "close factor ignored", "healthy loans liquidatable" |
| F-05 | Medium | Design review | **Rounding in the borrower's favour.** If debt shares round down, borrowing 1 wei when the borrow index is above 1.0 creates 0 shares: free money, repeatable without limit. Rounding payouts up instead of down would drain the pool by 1 wei at a time. | Debt shares and debt round **up** (`Math.Rounding.Ceil`); lender payouts, seized collateral and debt reduced on repay round **down**. | `debt rounds up: borrowing 1 wei 50 times creates at least 50 wei of debt (F-05)`, fuzz "books always match", mutation "debt rounds down" |
| F-06 | Medium | Review round 2 | **Mismatched decimals and odd tokens.** Value is computed as amount × price. With a 6-decimal dollar token against an 18-decimal collateral token, every collateral would be valued 10¹² times too high. A fee-on-transfer token would make the pool book money that never arrived. | The constructor refuses tokens with different decimals (`DecimalsMismatch`). `_pullExact` checks the balance really grew by the amount and otherwise reverts (`TokenMismatch`). | `rejects zero addresses and using the same token…` (6-decimal case), `refuses fee-on-transfer tokens…`, mutation "fee token accepted" |
| F-07 | Medium | Design review | **Share-price manipulation.** If the share price used `balanceOf(pool)`, anyone could donate HUSD to change it, the classic first-depositor trick (Day 20 goes deeper). | Cash is tracked in `totalCash`, so donations change nothing, and virtual shares (10⁶) and assets (1) make a first-depositor attack unprofitable. | `donating HUSD straight to the pool does not change the share price`, fuzz "pool balance equals its books" |
| F-08 | Medium | Design review | **Interest added late.** If an action ran before the interest since the last update was added, a borrower could repay at yesterday's debt, and a lender could redeem before a big interest payment was counted (or after a loss was hidden). | Every state-changing function calls `accrue()` first. 10% of each interest payment goes to reserves at the same moment. | `every action settles interest first…`, `a year of interest: … it all adds up`, mutations "no accrual before repay", "no reserve cut" |

Also checked and fine: lent-out cash cannot be redeemed until repaid (`InsufficientCash`), the owner can take only the reserves and never lenders' money, zero amounts revert everywhere, the interest model gives exactly 2 / 6 / 10 / 55 / 100%, a year of interest adds up to the wei between borrower, lenders and reserves, and every external function that moves tokens is `nonReentrant`.

`slither` reported 0 results on the main contracts (OpenZeppelin and test helpers are excluded in `slither.config.json`; `timestamp` is excluded because interest and price age are time-based by design). Two detectors were reviewed and silenced inline with a comment: `incorrect-equality` on `elapsed == 0` (our own timestamps, nothing an attacker controls) and `unused-return` on `latestRoundData()` (only the price and its time are needed). solhint flagged a possible re-entrancy in the test-only `MiniPair` swap: fixed by updating reserves before the transfers.

No high or medium issues remain open.

## Known issues (by design, documented)

- **The price reporter is trusted.** Whoever owns `HimalPriceFeed` decides the price. On a real network this would be a Chainlink feed run by many independent nodes, ideally with a second source as a cross-check.
- **A stale feed also stops liquidations.** That is safer than liquidating at a wrong price, but if the feed stays down while the price really falls, bad debt can grow. Real protocols watch the feed and have a fallback oracle.
- **Liquidations need someone to show up.** If the price falls very fast, nobody may liquidate in time and the loss becomes bad debt (written off as in F-03). Real protocols run liquidation bots.
- **One market, fixed settings.** One collateral token, one loan token, constant LTV / threshold / bonus, no supply or borrow caps.
- **Tiny loans may not be worth liquidating** because the 5% bonus does not cover gas. Real protocols set a minimum borrow size.
- **Rebasing tokens are not supported**, and fee-on-transfer tokens are refused.

## Final run

```
21 passing
  Fuzz: 40 random runs of up to 25 actions each (books match, no panic, everyone gets out)
  Extra: FUZZ_RUNS=400 → 1 passing
npm audit --omit=dev: found 0 vulnerabilities
solhint: 0 warnings, 0 errors
slither: 24 contracts analyzed, 0 results
mutation check: 14 of 14 broken versions caught
```
