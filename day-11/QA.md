# Day 11 — QA and security review

**Contract:** `contracts/HimalPeaks.sol` · **Off-chain:** `lib/allowlist.js` · **Test helpers:** `contracts/test/Attackers.sol` · **Security focus:** minting past the limit, bots

## How it was checked

1. Unit tests for every function, custom error and event (`npx hardhat test`), including the exact edges: the last token for sale, the last reserve token, and token `maxSupply + 1` not existing.
2. **300 real allowlist mints** from 300 separate wallets, each with its own Merkle proof from `lib/allowlist.js`.
3. Attack-style tests: wrong phase, a wallet not on the list, someone else's proof, a changed proof, a proof from a different list, an inner node used as a leaf, going over the wallet limits in one or several transactions, wrong payment (less, more, zero, the cheaper price), zero quantity, a huge quantity, buying into the team reserve, the team going over the reserve, a bot contract that mints again from `onERC721Received`, a contract that cannot hold NFTs, a treasury that refuses ETH, changing the art after freezing, and strangers calling owner functions.
4. A fuzz test with **fast-check**: 100 random sequences of honest and cheating mints across all phases. After each sequence, total minted, per-wallet counts and the contract balance must match a simple JavaScript model, and supply can never pass the max.
5. Mutation check: 18 key lines were broken on purpose, one at a time. The tests caught 17 (see below for the one left).
6. `npm audit --omit=dev`, `solhint` (recommended rules), `slither`.
7. Manual review like an attacker: supply overflow, wallet-limit bypass, reentrancy through `_safeMint`, payment errors, proof forgery, owner powers, metadata swaps.

## Findings

F-01 to F-08 came from the attacker review of the design before the first build (each threat is written as a test that would fail on the naive version). F-09 and F-10 came from the tools and the mutation check.

| ID | Severity | Found by | Description | Fix | Proving test |
|----|----------|----------|-------------|-----|--------------|
| F-01 | High | Design review | **Minting past the max supply.** Several sale paths (allowlist, public, team) can each look fine alone but add up to more than the max. | One shared `_mintBatch` checks and moves the counter for every path. The sale stops at `maxSupply − unminted reserve`. | `the public can buy exactly up to maxSupply minus the reserve…`, fuzz |
| F-02 | High | Design review | **Reentrancy through `_safeMint`.** `_safeMint` calls the receiver, so a bot contract can call `publicMint` again before its counter is saved. | Limits and supply are saved before the first mint, and every mint function is `nonReentrant`. | `a bot contract cannot mint again from inside onERC721Received` |
| F-03 | High | Design review | **Copied allowlist proofs.** If the proof is for an address passed as a parameter, anyone can reuse a proof seen in the waiting transactions. | The leaf is built from `msg.sender`, and tokens go only to `msg.sender`. | `a wallet not on the list is rejected, even with … someone else's proof` |
| F-04 | High | Design review | **Inner node passed as a leaf.** An inner node is also a 64-byte hash; a single-hashed leaf lets a shorter proof get through. | Leaves are hashed twice, on-chain and off-chain. | `an inner node of the tree cannot be used…`, mutation "single-hash leaf" |
| F-05 | Medium | Design review | **Team reserve can be sold away**, or the owner can mint without limit. | `saleRemaining()` keeps the unminted reserve aside; `teamMint` is capped at `teamReserve` for ever. | `the sale cannot eat into the team reserve…` |
| F-06 | Medium | Design review | **Bots mint the whole sale from one wallet.** | Per-wallet limits (2 allowlist, 3 public), counted across transactions. | `the allowlist limit is 2 per wallet…`, `the public limit is 3 per wallet`, `the per-wallet limit also holds for a wallet contract…` |
| F-07 | Medium | Design review | **Overpaying by mistake.** A `>=` price check keeps any extra ETH sent. | Payment must be exactly `price × quantity`. | `payment must be exact…` |
| F-08 | Medium | Design review | **Owner can take the money elsewhere or swap the art.** | The treasury is immutable and is the only payout address. `freezeMetadata()` locks the link for ever. | `only the owner can withdraw, and the money only goes to the treasury`, `the owner can change the base URI until it is frozen…` |
| F-09 | Low | slither | **No event for the team counter.** `teamMinted` changed without its own event. Strict-equality and low-level-call notes in `withdraw`. | Added `TeamMinted`. The two `withdraw` lines are intended (exact zero check; `call` so a multisig treasury works) and are disabled with a reason. | `only the owner can team-mint…`, slither: 0 results |
| F-10 | Low | Mutation check | **Weak reentrancy test.** Removing `nonReentrant` from `publicMint` was not caught, because the bot had no ETH for its inner mint. | The test now funds the bot first, so only the guard can stop it. | `a bot contract cannot mint again from inside onERC721Received` |

**The one mutation left:** removing the max-supply check inside `_mintBatch` is not caught, because no normal path can reach it: the sale is already capped by `saleRemaining()` and the team by `teamReserve`. It stays as a backstop in case a future change adds a new mint path.

No high or medium issues remain open.

## Known issues (by design, documented)

- **Many wallets beat wallet limits.** One person can split money across many wallets in the public sale. The allowlist is the real filter.
- **The allowlist root is trusted.** People must check that the published list matches the root.
- **The owner controls the phases.** The owner can open, pause or close the sale at any time. Use a multisig as owner in real use.
- **The art lives off-chain.** The token link points to IPFS. Freezing locks the link, not the files behind it; pin the files.
- **Front-running in the public sale.** Anyone who pays more gas can mint first. This is fair-ish for a fixed price, but the order is not guaranteed.

## Final run

```
31 passing
npm audit --omit=dev: found 0 vulnerabilities
solhint: 0 warnings, 0 errors
slither: 0 results
Mutation check: 17 of 18 caught (1 unreachable backstop)
```
