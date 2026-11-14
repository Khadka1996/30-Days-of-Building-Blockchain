# Day 12 — QA and security review

**Contracts:** `contracts/HimalMarket.sol`, `contracts/HimalPrints.sol` (the NFT collection with ERC-2981 royalties) · **Test helpers:** `contracts/test/Helpers.sol` · **Security focus:** selling NFTs you no longer own

## How it was checked

1. Unit tests for every function, custom error and event (`npx hardhat test`), including the edges: a listing can be bought in the exact second it expires but not one second later; 1 hour and 180 days are allowed durations, 59 minutes and 181 days are not.
2. Attack-style tests: an old listing after the NFT was given away, approval taken away after listing, a burned NFT, a second purchase of the same NFT, a seller raising the price in front of a waiting buyer, a collection asking for 100% and 500% royalty, a `royaltyInfo` that reverts, a royalty receiver that rejects ETH, a wallet calling `withdraw()` again or `buy()` from inside its payout, and a buyer contract with no `onERC721Received`.
3. The naive version (`NaiveMarket`, moves the NFT from the current owner but pays the old lister) is in the tests too, to show the attack really steals the new owner's NFT.
4. Fuzz tests with **fast-check**:
   - 100 random prices (1 wei to 1,000,000 ETH) and royalty requests (0% to 1,000%): seller share plus royalty must always equal the price, and the royalty must never be above 10%.
   - 40 random sequences of up to 12 steps (list, buy, resell, withdraw by four people): after every step the market's ETH balance must equal exactly what it owes.
5. Mutation check: 16 key lines were broken on purpose, one at a time (no stale-owner check, no approval check, no expected-price check, underpaying accepted, no expiry check, listing not deleted on sale, no royalty cap, royalty not credited, seller paid the full price, withdraw not zeroed, no reentrancy guard, a stranger cancelling a valid listing, a seller buying their own NFT, a non-owner listing, anyone changing the price, a broken `royaltyInfo` blocking the sale). The tests caught all 16.
6. `npm audit --omit=dev`, `solhint` (recommended rules), `slither`.
7. Manual review like an attacker: stale listings, approvals, front-running, untrusted royalty data, payout denial-of-service, reentrancy, rounding, access control.

## Findings

F-01 to F-06 came from the attacker review of the design before the first build (each threat is written as a test). F-07 came from solhint and slither on the first build.

| ID | Severity | Found by | Description | Fix | Proving test |
|----|----------|----------|-------------|-----|--------------|
| F-01 | High | Design review | **Selling an NFT you no longer own.** The NFT stays in the seller's wallet while listed. A market that moves the NFT from its *current* owner but pays the *old* lister lets an old listing sell someone else's NFT (the new owner only needs to have approved the same market). | At sale time `buy()` requires `ownerOf(tokenId) == seller` (`StaleListing`) and a live approval (`NotApproved`). A new owner's listing replaces the old one. | `ATTACK on the naive market…`, `the same attack fails on HimalMarket with StaleListing`, mutation "no stale-owner check" |
| F-02 | Medium | Design review | **Price raised in front of the buyer.** A seller watching waiting transactions can call `updatePrice()` just before a purchase lands. | `buy()` takes `expectedPrice` and must receive exactly the price; any change reverts with `PriceChanged`. | `front-running: a price raise while the buyer waits…` |
| F-03 | Medium | Design review | **Greedy royalty.** `royaltyInfo` is controlled by the NFT contract. It could ask for 100% or more than the price, taking the seller's money or making the subtraction fail. | Royalty capped at 10% of the price (`MAX_ROYALTY_BPS`). | `a greedy royalty (100%) is capped at 10%`, `a royalty bigger than the price…`, fuzz: 100 runs |
| F-04 | Medium | Design review | **Payout denial-of-service.** Paying the seller and the artist inside `buy()` means one wallet that rejects ETH blocks every sale of that collection. | Pull payments: shares are written to `proceeds` and collected with `withdraw()`. A bad wallet only blocks its own withdrawal. | `an artist wallet that rejects ETH cannot block sales…` |
| F-05 | Medium | Design review | **Reentrancy on payouts.** A seller contract can call back into `withdraw()` or `buy()` while it is being paid. | State is zeroed before the ETH transfer, plus `nonReentrant` on `buy()` and `withdraw()`. | `reentrancy: withdrawing again…`, `reentrancy: buying from inside a payout…` |
| F-06 | Low | Design review | **Broken royalty contract blocks sales.** A `royaltyInfo` or `supportsInterface` that reverts, or a zero receiver, would make every sale fail. | Both calls are wrapped in `try/catch`; anything strange means "no royalty". | `a broken royaltyInfo or a zero receiver does not block the sale` |
| F-07 | Low | solhint + slither | **Readability and tool warnings.** The single-letter variable `l` looks like `1`, and slither flags the `transferFrom(seller, …)` as an "arbitrary from". | Renamed to `item`. The `from` is the listed seller after the ownership and approval checks; the slither line is disabled with that reason. | solhint: 0 warnings, slither: 0 results |

`block.timestamp` is used only for listing expiry; validators can shift it by seconds at most. The low-level `call` in `withdraw()` is needed so smart-contract wallets can receive ETH, and its result is always checked.

No high or medium issues remain open.

## Known issues (by design, documented)

- **Ghost listing on return.** If Ram lists an NFT, gives it away, and later gets it back, his old listing works again at the old price. The market cannot see transfers made outside it. The 180-day maximum duration and `cancel()` limit this; sellers should cancel before moving an NFT.
- **Royalties are paid only on this market.** ERC-2981 is a request, not a rule. A direct wallet-to-wallet transfer pays no royalty.
- **Royalties above 10% are cut.** Collections asking for more get 10% here. This protects sellers but may be lower than an artist wants.
- **The NFT contract is trusted for `ownerOf` and transfers.** A malicious NFT contract can lie about itself; it can only hurt people who trade that collection.
- **A wallet that rejects ETH keeps its own money stuck.** It stays recorded in `proceeds`; only that wallet is affected.

## Final run

```
30 passing
npm audit --omit=dev: found 0 vulnerabilities
solhint: 0 warnings, 0 errors
slither: 0 results
Mutation check: 16 of 16 caught
```
