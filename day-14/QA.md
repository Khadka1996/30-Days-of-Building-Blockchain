# Day 14 — QA and security review

**Contracts:** `contracts/HimalVoteToken.sol` (ERC20Votes), `contracts/HimalDAO.sol` (Governor), `contracts/HimalTimelock.sol` (treasury), `contracts/CommunityFund.sol` (something the DAO controls) · **Deploy routine:** `scripts/deployDAO.js` · **Test helpers:** `contracts/test/` (`FlashLender`, `FlashVoter`, `NaiveDAO`, `OptionalTagDAO`) · **Security focus:** flash-loan voting, proposal spam

## How it was checked

1. Unit tests for the full life of a proposal (`npx hardhat test`): pending → active → succeeded / defeated → queued → executed, with every wrong-time call tested (voting before the delay, queueing while voting is open, executing before queueing, executing 1 minute before the 2-day wait ends, executing twice, voting after the end, cancelling after voting starts). Edges: a tie is a loss, quorum is exactly 40,000 HVT, Abstain counts toward quorum but not toward winning, 1 wei under the proposal threshold fails and exactly 10,000 HVT works.
2. Attack-style tests with hostile contracts:
   - `FlashVoter` borrows 600,000 HVT (60% of the supply) from `FlashLender` for one transaction and tries to vote and to propose.
   - `NaiveDAO` (votes = balance right now, runs as soon as it has a majority) is in the tests to show the same flash loan really drains it.
   - `OptionalTagDAO` (OpenZeppelin's default description rule) is in the tests to show the copy-and-cancel attack really works there.
   - Double voting: the same address twice, and voting then handing the tokens to a friend who votes again.
   - Bypassing the vote: the deployer calling the timelock or granting itself a role, a member calling the fund directly, changing DAO settings directly.
3. Fuzz tests with **fast-check**:
   - 60 random elections: 5 voters with random holdings (0–97,000 HVT) and random choices (none / for / against / abstain), some of whom pass their tokens on after voting. The on-chain tally must equal a JavaScript model, and the result (Succeeded / Defeated) must match `For > Against and For + Abstain ≥ 4%`.
   - 40 random flash loans (1 to 500,000 HVT): the borrower's vote weight is always 0, it can never create a proposal, and the lender always gets every token back.
4. Mutation check: 10 key lines were broken on purpose, one at a time (deployer admin not renounced, executor role not open, no timelock delay, no voting delay, no quorum, no proposal threshold, untagged descriptions accepted, the address inside the tag not checked, `onlyOwner` removed from the fund, DAO not given the canceller role). The tests caught all 10.
5. `npm audit --omit=dev`, `solhint` (recommended rules), `slither`.
6. Manual review like an attacker: flash-loan and bought votes, proposal spam, front-running proposals, admin backdoors, timelock bypass, stuck funds, double voting, quorum and tie edges, input validation.

## Findings

F-01 to F-05 came from the attacker review of the design before the first build (each threat is written as a test that fails on the naive version). F-06 came from re-reviewing the first build.

| ID | Severity | Found by | Description | Fix | Proving test |
|----|----------|----------|-------------|-----|--------------|
| F-01 | High | Design review | **Flash-loan voting.** If a vote is weighted by the voter's balance at the moment of voting, anyone can borrow most of the supply for one transaction, propose, vote, execute and repay. The demo drains the naive DAO's 10 ETH this way with 0 tokens of its own. | Votes come from `ERC20Votes` checkpoints read at the proposal snapshot, a block in the past (`getPastVotes`). A voting delay of 7,200 blocks and a 2-day timelock mean nothing can run in the same transaction. | `NAIVE DAO: a flash loan of 600,000 tokens drains its treasury…`, `HIMAL DAO: the same flash loan gives 0 votes…`, fuzz "40 random flash loans" |
| F-02 | Medium | Design review | **Proposal spam.** With no threshold, anyone can create thousands of proposals and bury the real ones, or slip a bad one in when nobody is watching. A flash loan could also be used to reach a threshold. | Proposing needs 1% of the supply (10,000 HVT) of voting power measured one block in the past, so borrowed tokens do not count. | `a small holder (5,000 HVT) cannot create proposals`, `the threshold edge…`, `HIMAL DAO: a flash loan cannot meet the proposal threshold either` |
| F-03 | High | Design review | **Admin backdoor in the timelock.** The deployer must be admin for a moment to give the DAO its roles. If it keeps that role, it can grant itself the proposer role and empty the treasury without any vote. | The deploy routine renounces the deployer's admin role as its last step. The timelock administers itself, so roles change only through a passed proposal. | `the deployer keeps no power over the treasury (admin renounced)`, `nobody can bypass the vote…`, mutation "admin not renounced" |
| F-04 | Medium | Design review | **One person can block execution.** If only one address has the executor role, that person can refuse to run a passed proposal. | The executor role is given to `address(0)`, so anyone can execute once the wait is over. | `propose → vote → queue → wait 2 days → execute` (executed by an outsider), mutation "executor not open" |
| F-05 | Medium | Design review | **Double voting by moving tokens.** Vote, send the tokens to a second wallet, vote again. | Same snapshot as F-01: the second wallet had 0 votes at the snapshot, so its vote weighs 0. One vote per address is enforced by `GovernorAlreadyCastVote`. | `vote, pass the tokens to a friend, vote again…`, fuzz "60 random elections" (tokens moved after voting) |
| F-06 | Medium | Review of build 1 | **Copy-and-cancel front-running.** In OpenZeppelin's default, the `#proposer=0x…` tag at the end of a description is optional. A member with enough votes who sees Ram's proposal waiting can send the exact same one first, become its proposer and cancel it. The proposal ID is a hash of the content, so Ram's proposal can then never be created again. | `HimalDAO` overrides `_isValidDescriptionForProposer` so the tag is **required**: every description must end with `#proposer=<sender address in lowercase>`. Tags the default rule silently ignores (checksummed case, trailing space, non-hex, wrong key) are rejected. | `OPTIONAL TAG (OpenZeppelin default): Hari copies Ram's waiting proposal…`, `HIMAL DAO: a description without the '#proposer=' tag is rejected`, `HIMAL DAO: Hari cannot submit Ram's tagged proposal first…`, mutations "untagged accepted" and "address in tag not checked" |

Also checked and fine: ETH sent to the Governor by mistake is rejected (`GovernorDisabledDeposit`) instead of getting stuck; DAO settings can only be changed by the DAO itself (`GovernorOnlyExecutor`); a proposal asking for more ETH than the treasury holds fails at execution and moves nothing; the token has a fixed supply with no mint function.

`slither` reported 0 results on the main contracts (OpenZeppelin and test helpers are excluded in `slither.config.json`; `timestamp` is excluded because the timelock clock uses `block.timestamp` by design).

No high or medium issues remain open.

## Known issues (by design, documented)

- **Votes can still be bought during the 1-day delay.** The snapshot is taken when voting starts (proposal block + 7,200), not when the proposal is made. Someone who buys or borrows tokens across blocks and holds them past the snapshot does get those votes; the delay exists so honest holders can delegate in time. A flash loan cannot do this, because it must be repaid in the same transaction. Proven by `documented: tokens moved during the 1-day delay DO count`.
- **Holders must delegate to vote.** Tokens that were never delegated (even to yourself) carry no votes. The demo and README show the one-time `delegate` call.
- **A 51% holder controls the DAO.** Token voting is "one token, one vote". The 2-day timelock gives everyone else time to see a bad proposal coming and leave.
- **Late swing votes.** A big holder can vote in the last block and flip the result. OpenZeppelin's `GovernorPreventLateQuorum` extension can extend voting in that case; it is left out to keep the code small.
- **Descriptions must be tagged.** Front ends and scripts must add `#proposer=<lowercase address>`. A missing tag fails loudly with `GovernorRestrictedProposer`; it cannot pass silently.
- **Low turnout.** Quorum is 4% of the total supply. A real DAO tunes this to its actual turnout.

## Final run

```
34 passing
npm audit --omit=dev: found 0 vulnerabilities
solhint: 0 warnings, 0 errors
slither: 59 contracts analyzed, 0 results
mutation check: 10 of 10 broken versions caught
```
