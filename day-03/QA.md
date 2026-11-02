# Day 03 — QA and security review

**Contract:** `contracts/Voting.sol` · **Security focus:** double voting, voting after the deadline

## How it was checked

1. Unit tests for every function, every custom error and the exact deadline second (`npx hardhat test`)
2. Attack-style tests: voting twice, changing a vote, voting one second late, reading the result one second early, a stranger cancelling, the creator cancelling a poll that is already losing
3. A fuzz test with **fast-check**: 50 random sequences of votes by 8 addresses on 2 polls with random time jumps, checked against a simple JavaScript model, plus invariants (`totalVotes` = sum of option votes = number of addresses that voted)
4. `npm audit --omit=dev`, `solhint` (recommended rules), `slither`
5. Manual review like an attacker: double voting, deadline edges, access control, result manipulation, input validation, denial of service

## Findings

Findings F-01 to F-06 came from the manual review of the first design, before the first commit; F-07 and F-08 came from slither on the first build. Each one is now guarded by a test.

| ID | Severity | Found by | Description | Fix | Proving test |
|----|----------|----------|-------------|-----|--------------|
| F-01 | High | Manual review | Without a record of who voted, one address could call `vote()` again and again and decide any poll alone. | `_hasVoted[pollId][voter]` is set before the vote is counted; a second call reverts with `AlreadyVoted`. Votes cannot be changed. | `the same address cannot vote twice, even for the same option`, `a vote cannot be changed`, fuzz test |
| F-02 | Medium | Manual review | A `cancelPoll` that works at any time lets the creator watch the running totals and throw away a poll their side is losing. | Cancelling is allowed only for the creator, only while the poll is open and only **before the first vote** (`CannotCancelAfterVotes`). | `the creator cannot cancel once someone has voted (no throwing away a losing poll)` |
| F-03 | Medium | Manual review | An off-by-one deadline check (`<=` for voting, `>=` for results) creates one second where people can still vote **and** the "final" result can be read, so the result can change after it was announced. | One rule for both, computed in `status()`: voting while `now < deadline`, results only when `now >= deadline`. | `accepts a vote 1 second before the deadline, refuses one exactly at it`, `there is no second where you can vote AND read the final result` |
| F-04 | Medium | Manual review | A simple "highest count wins" loop silently returns the **first** option on a tie, announcing a winner that did not win. | `getResult` returns an `Outcome` enum: `Winner`, `Tie` or `NoVotes`. | `reports a tie instead of silently picking the first option`, `reports NoVotes when nobody voted` |
| F-05 | Medium | Manual review | An unlimited number of options (or very long texts) makes `getResult` and `getPoll` too expensive to call: the result could become unreadable. | 2–10 options, question ≤ 200 bytes, option ≤ 50 bytes, empty texts rejected. | `needs 2 to 10 options (keeps the result loop small)`, `rejects empty or too long option text`, `rejects an empty or too long question` |
| F-06 | Low | Manual review | A deadline typed in **milliseconds** (a common JavaScript mistake) keeps a poll open for ~50,000 years; a deadline in the past makes a poll nobody can vote in. | The deadline must be 5 minutes to 30 days from now (`BadDeadline`). There is no way to move a deadline after creation. | `needs a deadline 5 minutes to 30 days away (catches milliseconds)` |
| F-07 | Info | slither (`uninitialized-local`) | The `tie` flag in `getResult` relied on the default `false`. | Initialised explicitly for readability. | `shows the winner after the deadline` |
| F-08 | Info | slither (`timestamp`) | `block.timestamp` can be nudged by a validator by a few seconds. | Accepted: polls last 5 minutes to 30 days, so a few seconds do not matter. Documented in the code and suppressed on that line. | `accepts a vote 1 second before the deadline, refuses one exactly at it` |

No high or medium issues remain open.

## Known issues (by design, documented)

| ID | Description | Why it is accepted today |
|----|-------------|--------------------------|
| K-01 | **One vote per address is not one vote per person.** Anyone can create many addresses for free (a Sybil attack). | Fixing it needs an identity or membership check (an allowlist, a token, a proof of personhood). Later days add access lists and tokens. Use this contract only for low-stakes polls. |
| K-02 | **Votes are public.** Everyone can see the running totals and who voted for what, so late voters can react to early ones. | Secret ballots need commit–reveal or zero-knowledge proofs, which are out of scope for Day 3. |
| K-03 | Anyone can create polls. | The creator pays the gas for storage, and every poll is capped in size, so spam cannot hurt other polls. |

## Final green run

```
  Voting
    creating a poll
      ✔ stores the poll, emits PollCreated and starts ids at 1 (661ms)
      ✔ rejects an empty or too long question
      ✔ needs 2 to 10 options (keeps the result loop small)
      ✔ rejects empty or too long option text
      ✔ needs a deadline 5 minutes to 30 days away (catches milliseconds)
      ✔ unknown poll ids are reported as None / PollNotFound
    voting
      ✔ counts a vote, marks the voter and emits Voted
      ✔ rejects an option that does not exist
      ✔ voting in one poll does not use up your vote in another
    security: double voting
      ✔ the same address cannot vote twice, even for the same option
      ✔ a vote cannot be changed
      ✔ the poll creator gets exactly one vote like everyone else
    security: deadline
      ✔ accepts a vote 1 second before the deadline, refuses one exactly at it
      ✔ the result is not available while voting is still open
      ✔ there is no second where you can vote AND read the final result
    results
      ✔ shows the winner after the deadline
      ✔ reports a tie instead of silently picking the first option
      ✔ a winner in the last option is found too
      ✔ reports NoVotes when nobody voted
    security: cancelling
      ✔ the creator can cancel before any votes; then nobody can vote or read a result
      ✔ only the creator can cancel
      ✔ the creator cannot cancel once someone has voted (no throwing away a losing poll)
      ✔ the creator cannot cancel after the deadline or cancel twice
    fuzz: random voters, choices and time jumps
      ✔ counts always match a simple model, nobody votes twice (50 random runs) (3393ms)


  24 passing (4s)
```

| Tool | Result |
|------|--------|
| `npm audit --omit=dev` | found 0 vulnerabilities |
| `solhint` (recommended) | 0 warnings, 0 errors |
| `slither` (102 detectors) | 0 results (after fixing F-07; F-08 reviewed and suppressed on that line) |
