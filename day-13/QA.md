# Day 13 — QA and security review

**Contracts:** `contracts/EnglishAuction.sol`, `contracts/DutchAuction.sol`, `contracts/HimalArt.sol` (the NFT being sold) · **Test helpers:** `contracts/test/Bidders.sol` · **Security focus:** front-running, refund denial-of-service

## How it was checked

1. Unit tests for every function, custom error and event (`npx hardhat test`), including the exact edges: a bid one second before the end works and a bid at the end time fails; a bid exactly 10 minutes before the end does not extend, one inside the last 10 minutes does; the seller can cancel a Dutch auction at the end of the price drop but not one second earlier.
2. Attack-style tests with hostile contracts: a bidder whose wallet refuses ETH, a winner that refuses NFTs in `onERC721Received`, a bidder that calls `withdraw()` again while being paid, a buyer that calls `buy()` again from inside its change payment, a sniper bidding in the last second, a bid beaten while waiting in the queue, and a seller cancelling in front of a buyer.
3. The naive version (`PushRefundAuction`, refunds paid inside `bid()`) is in the tests too, to show the attack really freezes it.
4. Fuzz tests with **fast-check**:
   - English: 60 random runs of up to 25 steps (bids, too-low bids, withdrawals, waits of up to 6 hours). After every step the contract balance must equal the top bid plus everything owed back, and each person's `pendingReturns` must match a JavaScript model. At the end everyone withdraws and the contract must hold exactly 0.
   - Dutch: 40 random auctions (prices up to 1,000 ETH, any length from 1 hour to 30 days). At random times the price must match the formula, never go up and never drop below the floor.
5. Mutation check: 18 key lines were broken on purpose, one at a time (no credit for the outbid bidder, no minimum bid, increment rounded down, no anti-sniping, bid allowed at the end time, ending early, withdraw not zeroed, cancel with bids, seller bidding, seller not paid, `safeTransferFrom` to the winner, Dutch price rounded down, price below the floor, underpaying accepted, no change refund, seller cancelling during the drop, a second buyer, proceeds not zeroed). The tests caught all 18.
6. `npm audit --omit=dev`, `solhint` (recommended rules), `slither`.
7. Manual review like an attacker: front-running (by bidders, buyers and the seller), refund and transfer denial-of-service, reentrancy, access control, rounding, deadline edges, input validation.

## Findings

F-01 to F-06 came from the attacker review of the design before the first build (each threat is written as a test that would fail on the naive version). F-07 came from re-reviewing the first build. F-08 came from slither.

| ID | Severity | Found by | Description | Fix | Proving test |
|----|----------|----------|-------------|-----|--------------|
| F-01 | High | Design review | **Refund denial-of-service.** If `bid()` pays the previous leader back straight away, a bidder contract that rejects ETH makes every higher bid revert. It wins with a low bid and the auction is frozen. | Pull payments: the outbid amount is added to `pendingReturns` and the bidder calls `withdraw()`. A failing wallet only blocks its own withdrawal. | `refund DoS: the naive push-refund auction is frozen…`, `refund DoS: a bidder that rejects ETH cannot block new bids or the end` |
| F-02 | Medium | Design review | **Winner blocks the ending.** With `safeTransferFrom`, a winning contract can revert in `onERC721Received`, so `end()` always fails and the seller's money is locked for ever. Same risk for a Dutch buyer. | Both auctions hand over the NFT with `transferFrom`. A contract that cannot handle NFTs only hurts itself. | `a winner contract that rejects NFTs cannot lock the seller's money`, `a buyer contract that rejects NFTs via the safe hook…`, mutation "safeTransfer to winner" |
| F-03 | Medium | Design review | **Sniping (last-second front-running).** A bot can wait for the final block and outbid by 1 wei, so nobody has time to answer. | A bid in the last 10 minutes moves the end to 10 minutes after that bid, and each bid must be at least 5% higher. | `a sniper's last-second bid gives the others time to answer`, `a bid in the last 10 minutes moves the end…` |
| F-04 | Medium | Design review | **Reentrancy on payouts.** A bidder or buyer contract can call back into `withdraw()` or `buy()` while it is being paid. | Checks, then state changes, then the ETH transfer; plus `nonReentrant` on `withdraw()` and `buy()`. | `reentrancy: calling withdraw again…`, `reentrancy: buying again from inside the change payment fails` |
| F-05 | Medium | Design review | **Seller pulls the item.** In the English auction the seller could cancel after seeing bids they do not like, or bid on their own item from the seller address. | `cancel()` only while there are no bids; the seller address cannot bid. | `the seller cannot pull the item once someone has bid`, `the seller cannot bid up their own item` |
| F-06 | Low | Design review | **Tiny bids with no step.** 5% of a very small bid rounds down to 0, so the "minimum raise" would be 0 wei. | The step is rounded up, so it is always at least 1 wei. | `the step is never zero, even for a tiny reserve`, mutation "increment rounded down" |
| F-07 | Medium | Review of build 1 | **Seller front-runs a Dutch buyer.** In build 1 the seller could cancel at any time before a sale. Watching the waiting transactions, they could cancel just before a buyer's purchase once the price fell lower than they liked, so the advertised price curve was not a real promise. | `cancel()` is only allowed after the price drop has ended with no buyer (`PriceStillFalling` before that). | `front-running: the seller cannot cancel in front of a buyer…`, `the seller can take an unsold NFT back only after the price drop ends` |
| F-08 | Low | slither | **Shadowing.** A local variable named `end` hid the `end()` function, which is easy to misread. | Renamed to `closesAt`. | slither: 0 results |

`slither` also reports strict equalities on `endAt == 0` / `startAt == 0` (intended: 0 means "not started") and the low-level `call` used to send ETH (needed so smart-contract wallets can receive; the result is always checked). Both are disabled on those lines with a reason. `block.timestamp` is used for the auction clock only; validators can shift it by seconds at most.

No high or medium issues remain open.

## Known issues (by design, documented)

- **Bids are public.** Anyone can see a waiting bid and bid higher first. That is how an open English auction works; a bid that gets beaten simply reverts, and the bidder only loses gas. Hiding bids needs a sealed-bid (commit-reveal) auction.
- **Dutch auctions are first come, first served.** If two people buy at the same moment, the one ordered first wins and the other reverts with `AuctionClosed`. Nobody can raise the price, so a slow transaction can only pay less.
- **Shill bidding from another wallet.** The contract blocks the seller's own address, but cannot know if a different wallet belongs to the seller.
- **Endless extensions cost real money.** Late bids keep extending the English auction, but each one must be 5% higher, so this cannot be done for free.
- **A bidder whose wallet rejects ETH keeps its refund stuck.** It is still recorded in `pendingReturns`; only that bidder is affected.
- **The NFT contract is trusted.** The seller picks it. A malicious NFT contract could misbehave; use a standard ERC-721.

## Final run

```
46 passing
npm audit --omit=dev: found 0 vulnerabilities
solhint: 0 warnings, 0 errors
slither: 0 results
Mutation check: 18 of 18 caught
```
