# Day 10 — QA and security review

**Contracts:** `contracts/MerkleAirdrop.sol`, `contracts/HimalToken.sol` (same as Day 08) · **Off-chain:** `lib/airdrop.js` · **Security focus:** claiming twice, fake proofs

## How it was checked

1. Unit tests for every function, custom error and event (`npx hardhat test`), including the exact edges: a claim on the last second works, one second later fails; a sweep on the last second fails.
2. **1,000 real claims** from 1,000 separate wallets, with the bitmap checked across word boundaries (positions 255, 256, 511, 512), and the contract ending at exactly zero.
3. Attack-style tests: claiming twice, a stranger using a copied proof, raising the amount, using another index, an empty proof, a changed proof, a proof from a different list, an inner node passed as a leaf, a single-hash leaf, a list whose amounts add up to more than the total, and a hostile token that calls `claim` again during payment.
4. A fuzz test with **fast-check**: 100 random lists with random orders of honest and cheating claims. After every step, the amount paid and the contract balance must match a simple JavaScript model.
5. A hand-written Merkle walk in the tests confirms that the off-chain tree and the contract agree.
6. Mutation check: 14 key lines were broken on purpose, one at a time (no double-claim check, no proof check, leaf ignoring the amount, single-hash leaf, no deadline, early sweep, two off-by-one deadlines, marking claimed after paying, no allocation cap, anyone can fund, funding twice, no funding check, sweep to the caller). The tests caught all 14.
7. `npm audit --omit=dev`, `solhint` (recommended rules), `slither`.
8. Manual review like an attacker: double claims, proof forgery, front-running, reentrancy, access control, deadline edges, input validation.

## Findings

F-01 to F-07 came from the attacker review of the design before the first build (each threat is written as a test that would fail on the naive version). F-08 and F-09 came from the tools on the first build.

| ID | Severity | Found by | Description | Fix | Proving test |
|----|----------|----------|-------------|-----|--------------|
| F-01 | High | Design review | **Claiming twice.** Without a record, the same proof pays every time. | A bitmap by list position, set before paying. | `claiming twice fails`, fuzz (`repeat` steps), 1,000-claim test |
| F-02 | High | Design review | **Copied proofs.** If a claim takes the recipient as a parameter, a proof seen in the waiting transactions can be replayed or redirected. | The leaf is built from `msg.sender`, and tokens only go to `msg.sender`. | `a stranger cannot use someone else's proof…` |
| F-03 | High | Design review | **Treating an inner node as a leaf.** An inner node is a hash of 64 bytes, so a single-hashed design can let it pass as an entry. | Leaves are hashed twice, on-chain and off-chain. | `an inner node of the tree cannot be passed off as a leaf`, `a single-hash leaf is rejected…` |
| F-04 | Medium | Design review | **Owner can take the tokens.** An owner with a withdraw function could empty the airdrop before people claim. | No owner. `sweep` works only after the deadline, and only pays the treasury. | `cannot sweep during the claim window…`, `after the deadline anyone can trigger it…` |
| F-05 | Medium | Design review | **A late deposit shortens the window**, or claims start before the money arrives. | `fund()` opens the window, so people always get the full period. Claims fail with `NotFunded` before that. | `funding moves the exact total and starts the full claim window`, `no claims and no sweep before funding` |
| F-06 | Medium | Design review | **Bad list drains other people's share.** If the amounts add up to more than the total, early claimers take what belongs to later ones. | `totalClaimed` can never pass `totalAllocation`. The list builder also computes the total itself. | `a list that promises more than the total…` |
| F-07 | Medium | Design review | **Bad list input.** A duplicate address or a zero amount would be sealed into the root for ever. | `buildAirdrop` rejects empty lists, duplicates in any letter case, bad checksums, the zero address and amounts of zero or less. | `rejects an empty list, duplicates…` |
| F-08 | Low | slither | **Stale balance and a late event in `fund()`.** The event was emitted after the external call, and a balance was read before it. | The event moved before the call. The check is now simply "the contract holds at least the total". | `refuses a token that delivers less…`, slither: 0 results |
| F-09 | Low | npm audit | **Vulnerable dependency.** `@openzeppelin/merkle-tree` pulled in packages with moderate advisories (`uuid`, then `elliptic` on the older version). | Removed it. `lib/airdrop.js` builds the tree in about 40 lines with ethers only, checked against the contract by every claim test. | `verifyProof agrees with a hand-written Merkle walk`, `npm audit`: 0 |

`slither` also reports strict equalities on `deadline == 0` and `remaining == 0`. Both are intended exact checks, disabled on those lines with a reason. Time is used for the claim window only; validators can shift it by seconds at most.

No high or medium issues remain open.

## Known issues (by design, documented)

- **The root is trusted.** People must check that the published list really matches the root, because the contract cannot judge whether the list is fair. Anyone can rebuild the root from the published list.
- **Lost key = lost claim.** Tokens go only to the listed wallet, and there is no address change.
- **Standard tokens only.** Fee-on-transfer tokens are refused at funding, and rebasing tokens are not supported. This contract is meant for a plain ERC-20 such as HIM.
- **Same root on two deployments can be claimed on both.** The leaf is not tied to one contract. Build a new list for each airdrop.
- **Other tokens sent here are stuck.** `sweep` only handles the airdrop token.

## Final run

```
28 passing
npm audit --omit=dev: found 0 vulnerabilities
solhint: 0 warnings, 0 errors
slither: 0 results
Mutation check: 14 of 14 caught
```
