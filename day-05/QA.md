# Day 05 — QA and security review

**Contract:** `contracts/Escrow.sol` · **Security focus:** stuck funds, wrong person releasing

## How it was checked

1. Unit tests for every function, every custom error and every event (`npx hardhat test`), including the exact deadline second (`deadline − 1` can still dispute, `deadline` cannot; the seller can claim at `deadline`, not one second earlier) and the exact arbiter timeout second
2. Attack-style tests: the seller, arbiter or a stranger trying to release the money; the arbiter acting without a dispute; a closed deal being moved again; withdrawing twice; a seller contract that calls `withdraw` again while being paid; a seller or buyer contract that refuses ETH; ETH forced in with `selfdestruct`; one deal's seller trying to reach another deal's money
3. A fuzz test with **fast-check**: 60 random sequences of open / confirm / refund / dispute / resolve / claim / timeout / withdraw / time jumps by 5 people, where **anyone tries anything**, checked step by step against a simple JavaScript model, plus invariants (the contract holds exactly what is still in open deals plus what it owes; every person's on-chain credit matches the model; every deal closes at most once)
4. **Mutation check:** six bugs were planted in the contract one at a time (arbiter acts without a dispute, late dispute allowed, `withdraw` not zeroed, release does not close the deal, arbiter not neutral, anyone can confirm). The tests caught all six (1–3 failing tests each), then the code was restored
5. `npm audit --omit=dev`, `solhint` (recommended rules), `slither`
6. Manual review like an attacker: stuck funds, wrong person releasing, paying out twice, reentrancy, deadline edges, front-running at the deadline, forced ETH, cross-deal accounting, input validation

## Findings

F-01 to F-08 came from the attacker review of the design before the first build; each threat is written as a test that fails on the naive version (proven by the mutation check above). Slither and solhint found nothing on the final build.

| ID | Severity | Found by | Description | Fix | Proving test |
|----|----------|----------|-------------|-----|--------------|
| F-01 | High | Design review | **Wrong person releasing.** In the textbook version the seller or the arbiter can call `release()` at any time and send the buyer's money to the seller. | Each move has exactly one allowed caller: only the **buyer** confirms delivery, only the **seller** refunds, only the **arbiter** resolves, and only **after a dispute**. | `only the buyer can confirm delivery…`, `only the seller can refund the buyer`, `the arbiter cannot move money unless there is a dispute`, `only the arbiter can resolve…` |
| F-02 | High | Design review | **Paying out twice.** Without a clear state, a deal could be released *and* refunded (for example the seller refunds during a dispute and the arbiter then releases), paying the same money twice. | A one-way **state machine**: `Funded → Disputed → Released / Refunded`. The state changes before any credit, and a closed deal can never move again (`WrongState`). | `a closed deal can never move again…`, `a refunded deal cannot then be released by the arbiter`, fuzz invariant "closed at most once" |
| F-03 | High | Design review | **Stuck funds: silent buyer.** If the buyer gets the item and never confirms, the seller's money is locked forever. | A **deadline** (1 to 180 days). If the buyer neither confirms nor disputes by then, the seller can `claimAfterDeadline`. | `buyer goes silent: the seller can claim only once the deadline has passed (exact second)` |
| F-04 | High | Design review | **Stuck funds: silent arbiter.** If the arbiter loses their key or disappears during a dispute, the money is locked forever. | `ARBITER_TIMEOUT` = 30 days: after that, buyer or seller can return the money to the buyer who paid it. | `arbiter goes silent: after 30 days the buyer gets the money back (not one second earlier)` |
| F-05 | High | Design review | **Push payments block closing.** Sending ETH inside `release`/`resolve` lets a seller or buyer contract that refuses ETH make every close fail, so the deal (and the arbiter's decision) is stuck. | **Pull payments:** closing a deal only credits `owed[...]`; each person calls `withdraw()`. A party that refuses ETH can only block its own withdrawal. | `a seller contract that refuses ETH cannot block the deal from closing`, `a buyer contract that refuses ETH cannot block the arbiter's decision` |
| F-06 | Medium | Design review | **Withdrawing twice / reentrancy.** Sending before zeroing `owed` lets a contract call `withdraw()` again from its `receive()` and drain other people's money. | `owed[msg.sender] = 0` **before** the transfer, plus a `nonReentrant` lock. | `a second withdraw pays nothing`, `a seller contract that calls withdraw again while being paid gets paid once` |
| F-07 | Medium | Design review | **Race at the deadline.** If a dispute were allowed at the same moment as the seller's claim, a buyer could front-run the claim forever. | Disputes only while `now < deadline`; claims only when `now ≥ deadline`. There is no second where both are possible. | `disputes are only allowed before the deadline…`, `a dispute at the last second still counts…` |
| F-08 | Medium | Design review | **Arbiter not neutral.** If the arbiter is the seller (or the buyer), "neutral judge" means nothing, and zero addresses would lock the money. | `openDeal` requires buyer, seller and arbiter to be three different, non-zero addresses. The arbiter is never paid by the contract. | `the arbiter must be neutral…`, `rejects zero payment, zero addresses…`, `the arbiter never receives the money…` |
| F-09 | Info | slither (`timestamp`), design | Deadlines compare `block.timestamp`. | Accepted: a deadline must use time. Validators can shift a timestamp by seconds only, which does not matter for deals of 1 to 180 days. The detector is excluded in `slither.config.json` with this reason. | exact-second tests above |
| F-10 | Info | design | Shared balance: all deals live in one contract and anyone can force ETH in with `selfdestruct`. | No decision uses `address(this).balance`; each deal pays exactly its own `amount`; plain transfers are refused (`DirectPaymentRejected`). | `ETH forced in with selfdestruct does not change any deal…`, `one deal's seller cannot reach another deal's money` |

No high or medium issues remain open.

## Known issues (by design, documented)

| ID | Description | Why it is accepted today |
|----|-------------|--------------------------|
| K-01 | **The arbiter is trusted.** A dishonest arbiter can rule for the wrong side. | That is what an arbiter is. It can never take the money itself, and both sides choose it before paying. A real version could use a panel (2 of 3 arbiters) or a decentralised court such as Kleros. |
| K-02 | **A silent arbiter favours the buyer.** After 30 days the money returns to the buyer, even if the seller was right. | The money goes back to whoever paid it, the safest default. A real version could split 50/50 or let the parties pick a backup arbiter. |
| K-03 | **A buyer can delay payment.** Opening a dispute just before the deadline holds the seller's money for up to 30 days. | The dispute is public and the arbiter can decide at once. A real version could ask a small dispute deposit that the loser pays. |
| K-04 | **A party that cannot receive ETH** keeps its own credit stuck in `owed`. | It only affects that one party, and the amount stays recorded. A real version could add `withdrawTo(address)`. |
| K-05 | The arbiter earns no fee. | Kept simple for a teaching project; a fee would be a fixed share agreed in `openDeal`. |

## Final green run

```
  Escrow
    open a deal
      ✔ stores the parties, amount and deadline and emits DealOpened (453ms)
      ✔ rejects zero payment, zero addresses, a too short or too long duration and unknown ids
      ✔ the arbiter must be neutral: buyer, seller and arbiter are three different addresses
      ✔ plain ETH sent to the contract is refused
    happy paths
      ✔ buyer confirms delivery: the seller is credited and withdraws the full amount
      ✔ seller refunds the buyer (e.g. out of stock)
      ✔ owed money from several deals adds up and is withdrawn in one call
    security: wrong person releasing
      ✔ only the buyer can confirm delivery (not the seller, arbiter or a stranger)
      ✔ only the seller can refund the buyer
      ✔ the arbiter cannot move money unless there is a dispute
      ✔ only the arbiter can resolve, and only buyer or seller can dispute
      ✔ the arbiter never receives the money: it goes only to the buyer or the seller
      ✔ a stranger cannot withdraw someone else's money
    security: paying out twice
      ✔ a closed deal can never move again (state machine only moves forward)
      ✔ a refunded deal cannot then be released by the arbiter
      ✔ a second withdraw pays nothing
      ✔ a seller contract that calls withdraw again while being paid gets paid once
    security: stuck funds
      ✔ buyer goes silent: the seller can claim only once the deadline has passed (exact second)
      ✔ only the seller can claim after the deadline
      ✔ disputes are only allowed before the deadline, so a late dispute cannot block the seller's claim
      ✔ a dispute at the last second still counts, and then the seller cannot claim
      ✔ arbiter goes silent: after 30 days the buyer gets the money back (not one second earlier)
      ✔ strangers and the arbiter cannot trigger the arbiter timeout
      ✔ the arbiter timeout needs a dispute first
      ✔ a seller contract that refuses ETH cannot block the deal from closing (pull payments)
      ✔ a buyer contract that refuses ETH cannot block the arbiter's decision
      ✔ ETH forced in with selfdestruct does not change any deal or anyone's credit
      ✔ one deal's seller cannot reach another deal's money
    fuzz: random actions by everyone, random time jumps
      ✔ money is never created or lost, and every deal closes exactly once (60 random runs) (3923ms)


  29 passing (5s)

```

```
solhint:    0 warnings
npm audit:  found 0 vulnerabilities
slither:    . analyzed (5 contracts with 101 detectors), 0 result(s) found
mutation:   6 planted bugs, 6 caught
```
