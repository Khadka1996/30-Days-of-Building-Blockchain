# Day 06 — QA and security review

**Contract:** `contracts/CrowdFund.sol` · **Security focus:** refund loops, claiming twice

## How it was checked

1. Unit tests for every function, every custom error and every event (`npx hardhat test`), including the exact deadline second (`endAt − 1` still pledges, `endAt` does not)
2. Attack-style tests: claiming twice, a stranger or a backer claiming, a creator contract that calls `claim` again while being paid, refunding twice, a backer contract that calls `refund` / `unpledge` again while being paid, a backer that refuses ETH, 40 backers vs 1 backer (refund gas), ETH forced in with `selfdestruct`, one campaign's creator trying to reach another campaign's money
3. A fuzz test with **fast-check**: 50 random sequences of pledge / unpledge / claim / refund / time jumps by 4 backers on 2 campaigns, checked step by step against a simple JavaScript model, plus invariants (the contract holds exactly what it still owes; each backer's on-chain pledge matches the model; a campaign is never both claimed and refunded)
4. `npm audit --omit=dev`, `solhint` (recommended rules), `slither`
5. Manual review like an attacker: claiming twice, refund loops (denial of service), reentrancy, deadline edges, access control, forced ETH, cross-campaign accounting, input validation

## Findings

F-01 to F-07 came from the attacker review of the design before the first build (each threat is written as a test that would fail on the naive version); F-08 to F-10 came from slither and solhint on the first build. Each one is now guarded by a test.

| ID | Severity | Found by | Description | Fix | Proving test |
|----|----------|----------|-------------|-----|--------------|
| F-01 | High | Design review | **Refund loop.** The textbook version refunds every backer in one `for` loop when the goal is missed. One backer contract that rejects ETH makes the whole loop revert, so **nobody** gets refunded; with thousands of backers the loop also runs out of gas. | **Pull payments:** no loop at all. Each backer calls `refund(id)` for their own money. A backer that cannot receive only blocks themselves, and their pledge stays recorded (never lost). | `a backer that refuses ETH cannot block anyone else's refund (no refund loop)`, `refund gas stays the same with 1 backer or 40 backers` |
| F-02 | High | Design review | **Claiming twice.** If `claim` sends the money before recording it, the creator can claim again (or re-enter from a contract) and take other campaigns' ETH. | `claimed = true` is written **before** the transfer (checks → effects → interaction) plus a `nonReentrant` lock; `AlreadyClaimed` afterwards. | `a second claim fails and pays nothing`, `a creator contract that calls claim again while being paid gets paid once` |
| F-03 | High | Design review | **Refunding twice.** Sending the refund before zeroing the pledge lets a backer contract call `refund` again from its `receive()` and drain everybody's money. | `pledgeOf[id][backer] = 0` **before** the transfer, `nonReentrant`; a second call reverts with `NothingToRefund`. Same pattern for `unpledge`. | `a second refund fails and pays nothing`, `a backer contract that calls refund again while being paid gets paid once`, `… unpledge again … cannot take more` |
| F-04 | High | Design review | **Shared balance.** All campaigns live in one contract. Using `address(this).balance` to decide success or to pay out lets one campaign's money count towards (or be paid out by) another, and lets anyone fake success by forcing ETH in with `selfdestruct`. | Every decision uses the campaign's own `pledged` counter; `claim` pays exactly that campaign's `pledged`; plain ETH transfers are refused (`DirectPaymentRejected`). | `a creator cannot drain another campaign's money`, `ETH forced in with selfdestruct does not change any campaign's numbers`, fuzz invariant |
| F-05 | Medium | Design review | **Both outcomes at once.** Without one clear rule, a campaign could be claimed by the creator *and* refunded to backers (paying out twice), or neither (money stuck). | One rule after the deadline: `pledged ≥ goal` → only `claim`; `pledged < goal` or cancelled → only `refund`. `cancel` is only allowed before the deadline, so a finished success cannot be turned into refunds. | `backers cannot refund a successful campaign`, `the creator cannot claim when the goal was missed`, `the creator cannot cancel after the deadline`, fuzz invariant "never both" |
| F-06 | Medium | Design review | **Deadline edges.** If pledging and refunding were both allowed at the same second, a pledge could land after the outcome was decided. A deadline years away would lock backers' money. | Pledges and unpledges only while `now < endAt`; claim and refund only when `now ≥ endAt`. Duration must be 1 hour to 90 days. | `rejects zero pledges and pledges at or after the deadline`, `no refunds while the campaign is still running`, `rejects a zero goal, a too short or too long duration…` |
| F-07 | Medium | Design review | **Wrong person.** Anyone (or a backer) calling `claim` or `cancel`. | Both check `msg.sender == creator` (`NotCreator`). Money only ever goes to `msg.sender`. | `only the creator can claim`, `a cancelled campaign refunds at once and can never be claimed` |
| F-08 | Low | slither (`arbitrary-send-eth`) | The first build sent ETH through a private `_send(to, amount)` helper, which hides who receives the money. | Each payment now sends to `msg.sender` directly in the function that checked it. | `each backer gets back exactly what they pledged`, `pays the creator the full total…` |
| F-09 | Info | slither (`timestamp`) | Deadlines compare `block.timestamp`. | Accepted: a deadline must use time. Validators can only shift a timestamp by seconds, which does not matter for a campaign that runs 1 hour to 90 days. The detector is excluded in `slither.config.json` with this reason. | `rejects zero pledges and pledges at or after the deadline` (exact edge) |
| F-10 | Info | slither (`low-level-calls`), solhint | `call{value:}` flagged; style warnings in the test-only attacker contracts (`contracts/test/`). | `call` is the recommended way to send ETH (it works for smart-contract wallets); the result is checked (`TransferFailed`) and the function is locked. Test helpers excluded from slither and their solhint rules disabled in that file only. | — |

No high or medium issues remain open.

## Known issues (by design, documented)

| ID | Description | Why it is accepted today |
|----|-------------|--------------------------|
| K-01 | **Last-minute unpledge.** A big backer can pledge early (so the campaign looks close to its goal) and take the money back just before the deadline. | Backers' money is theirs until the deadline; Kickstarter works the same way. A stricter version could lock pledges in the last 24 hours. |
| K-02 | **A backer that cannot receive ETH** keeps its refund stuck in the contract. | It only affects that one backer, and the amount stays recorded in `pledgeOf`. A real version could add `refundTo(address)`. |
| K-03 | **A creator who never claims** leaves a successful campaign's money in the contract forever. | Backers already agreed to give it. A real version could let the creator name a payout address or add a long claim window. |
| K-04 | The creator can pledge to their own campaign to reach the goal. | It is their own money: backers still pay only what they pledged, and the goal is a public number. |

## Final green run

```
  CrowdFund
    launch
      ✔ stores the creator, goal and deadline and emits Launched (1380ms)
      ✔ rejects a zero goal, a too short or too long duration and unknown ids (41ms)
    pledge and unpledge
      ✔ records each backer's pledge and the campaign total
      ✔ rejects zero pledges and pledges at or after the deadline
      ✔ a backer can take part of a pledge back before the deadline, never more than they put in
      ✔ no unpledge after the deadline
      ✔ plain ETH sent to the contract is refused
    success: the creator claims
      ✔ pays the creator the full total once the deadline passes with the goal reached
      ✔ the creator cannot claim before the deadline, even when the goal is already reached
      ✔ the creator cannot claim when the goal was missed
      ✔ backers cannot refund a successful campaign
    failure: backers pull their own refunds
      ✔ each backer gets back exactly what they pledged
      ✔ no refunds while the campaign is still running
      ✔ someone who never pledged gets nothing
      ✔ a cancelled campaign refunds at once and can never be claimed
      ✔ the creator cannot cancel after the deadline (a successful campaign stays successful)
    security: claiming twice
      ✔ a second claim fails and pays nothing (42ms)
      ✔ only the creator can claim
      ✔ a creator contract that calls claim again while being paid gets paid once
      ✔ a creator cannot drain another campaign's money
    security: refunds
      ✔ a second refund fails and pays nothing
      ✔ a backer contract that calls refund again while being paid gets paid once
      ✔ a backer contract that calls unpledge again while being paid cannot take more
      ✔ a backer that refuses ETH cannot block anyone else's refund (no refund loop) (51ms)
      ✔ refund gas stays the same with 1 backer or 40 backers (111ms)
      ✔ ETH forced in with selfdestruct does not change any campaign's numbers
    fuzz: random pledges, unpledges, time jumps, claims and refunds
      ✔ money is never created or lost and each campaign pays out one way only (50 random runs) (3412ms)


  27 passing (5s)

```

| Tool | Result |
|------|--------|
| `npm audit --omit=dev` | found 0 vulnerabilities |
| `solhint` (recommended) | 0 warnings, 0 errors |
| `slither` (101 detectors) | 0 results (after fixing F-08; `timestamp` excluded with the reason in F-09; test helpers excluded, F-10) |
