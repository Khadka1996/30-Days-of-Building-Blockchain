# Day 26 — QA and security review

**Scope:** `contracts/Messenger.sol` (cross-chain messenger, one copy per chain), `contracts/CrossChainTodo.sol` (the Day 1 to-do list that can receive tasks from the other chain), the validators and relayer (`relayer/relayer.js`, viem), the L2 cost model (`lib/gas-model.js`) and the page (`app/`). Contracts in `contracts/test/` are deliberately hostile test targets.

**Security focus (ROADMAP):** replay across chains and bridge risks. The questions:
- can a signed message be delivered **twice**, on **another chain**, on **another copy** of the bridge, or with any field changed?
- can an attacker deliver a message nobody sent (stolen key, fake event, unknown source, a reorg)?
- can one bad message, an offline validator or a spammer stop or drain the bridge?

All tests run on **two real local chains** (two `hardhat node` processes, chain IDs 31337 and 31338).

## How it was tested

| Layer | Tool | What it covers |
|---|---|---|
| Contracts | Hardhat + chai (23 tests) | Both directions, nonces, 2-of-3 with any pair, same-chain replay, cross-chain replay, re-addressed envelope, twin messenger, re-entrancy replay, 1 stolen key, duplicate signer, outsiders, tampered text, high-s signatures, unknown source chain / messenger, pause (and nothing lost), owner-only admin, weak validator sets, size limits, fake `onMessage` calls, untrusted source chain, per-chain task lists, failing target rolls back and can be retried, bad text |
| Validators + relayer | viem on both chains (9 tests) | Confirmations (relayer **and** each validator), exactly-once delivery with a second relayer, fake `MessageSent` from an attacker contract, a message removed by a reorg, 1 or 2 validators offline (0 gas paid when stuck), retries, F-1, F-2, L2 cost model |
| Browser | Playwright + Chromium (4 tests) | Cost table, send each way and see it arrive, XSS in task text, bad input, path tricks, F-3 |
| Fuzz | fast-check (2 properties) | 150 random one-field tamperings of a signed message → all refused. 30 random sequences of sends (both ways, 2 users), relays, blocks and replays → every message delivered exactly once, in order, to the right (chain, sender) list, never mixed into local lists |
| Test of the tests | `npm run planted-bugs` | 21 real bugs planted one at a time (14 on-chain, 5 relayer, 2 page/server); the suite must fail for each |
| Tooling | npm audit · solhint · Slither | Dependencies, lint, static analysis |

## Findings (found and fixed during QA)

| ID | Severity | Found by | Description | Fix | Proving test |
|---|---|---|---|---|---|
| F-1 | **Medium** | Manual review (attacker view) | **One stuck message froze the whole bridge.** To keep messages in order, my first relayer stopped at the first failed delivery and retried from there on every poll. Anyone could send a message to a contract that always reverts (or a 101st task, which `TooManyTasks` refuses forever), and every message after it would never be delivered: a cheap, permanent denial of service. | Failed messages go into a **retry list** (retried up to 10 per poll) and the relayer moves on. The contract already guarantees each id is delivered at most once, so retries are safe. | `relayer.test.js` › F-1: a message that keeps failing does not block the messages after it (failed before the fix: `['failed']` instead of `['failed','delivered']`); planted "failed messages are dropped" caught |
| F-2 | Low | Manual review | **Anyone could make the relayer pay.** Sending a message is cheap on the L2, but delivering it costs ~195,000 gas on the destination, which may be the expensive L1. Messages to any contract were delivered at the relayer's cost. | Optional `allowedTargets` list: the app's relayer only pays for our own to-do contracts; other messages are reported "not paid for" (they stay valid; anyone else may deliver them). Real fix for production: a delivery fee paid on the source chain (see known issues). | `relayer.test.js` › F-2 (relayer balance unchanged; failed before the fix: it delivered); planted "relayer ignores its allow-list" caught |
| F-3 | Low | Manual review | **DNS rebinding on the local page.** The demo server sends transactions from a dev account and listens on 127.0.0.1. A malicious website can point its own domain at 127.0.0.1 and then call `/api/send` as "same-origin". | Refuse any request whose `Host` is not `127.0.0.1` / `localhost` (403). JSON-only `POST` already blocks plain cross-site forms. | `e2e.test.js` › F-3 (Host `evil.example` → 403); planted "no Host check" caught |
| T-1 | Info (test) | Planted bugs | The first planted-bug run caught 20 of 21: removing the **validator's own** confirmation check went unnoticed, because the relayer already waits. A validator must not trust the relayer to wait. | New test asks a validator directly for a 1-confirmation message. | `relayer.test.js` › each validator waits for confirmations on its own; now 21 of 21 |
| T-2 | Info | Slither `uninitialized-state` | False positive: `_tasks` was written through a storage pointer, which Slither didn't follow. | Write `_tasks[k].push(...)` directly; same behaviour, Slither clean. | All `CrossChainTodo` tests |

No high or medium findings are left open.

## Built-in defences (each has a test; the planted bug shows the test can fail)

| ID | Attack | Defence | Planted bug caught |
|---|---|---|---|
| D-01 | **Replay on the same chain** | `processed[id]`, set **before** calling the target; `nonReentrant` | never marks processed · no already-processed check |
| D-02 | **Replay on another chain** | `m.dstChainId == block.chainid`, and the id includes both chain IDs | no destination-chain check · id without destination chain |
| D-03 | **Replay on a second copy of the bridge** | `m.dstMessenger == address(this)`, and the id includes both messenger addresses | no destination-messenger check |
| D-04 | **Forged source** | Only the one trusted messenger per remote chain (`remotes`), owner-only `setRemote` | no trusted-source check |
| D-05 | **One stolen validator key** | 2 of 3 distinct validators (ascending signer order = no duplicates), threshold must be a strict majority | one signature is enough · same validator twice · non-validators · 1-of-N sets |
| D-06 | **Changed message / malleable signature** | Every field is in the signed id; OpenZeppelin `ECDSA.recover` refuses high-s | (150 fuzz tamperings) |
| D-07 | **Fake event** | Validators only sign logs emitted by the real source Messenger, re-read from the tx receipt | validator signs any contract's events |
| D-08 | **Reorg** | 2 confirmations, checked by the relayer **and** by each validator; validators check the block hash is still canonical | relayer / validator ignore confirmations |
| D-09 | **Fake delivery to the app** | `onMessage` only from the Messenger, only from the trusted source chain | anyone may call onMessage · any source chain |
| D-10 | **Same address, different owner on another chain** | Remote tasks are stored under (source chain, address), never in a local user's list | tasks not separated per chain |
| D-11 | **Emergency** | Owner can pause sending and receiving; nothing is lost while paused | anyone may pause |
| D-12 | **XSS** | Task text via `textContent`, CSP `script-src 'self'` | page renders text as HTML |

Also checked: message data > 1024 bytes, address 0 target, unconnected destination, `setRemote` to its own chain, empty and 281-byte task text, target that reverts (whole delivery rolls back, can be retried), wrong `direction`, blank text, non-JSON body (415), path tricks on static files (fixed allow-list).

## Static analysis and dependencies

- `npm audit --omit=dev`: **0 vulnerabilities** (runtime dependency: `viem`).
- `solhint`: **0 problems**. The `immutable-vars-naming` style rule is off so public getters keep readable names (`messenger()`, `threshold()`).
- `slither`: **0 results** (`contracts/test/` excluded: deliberately hostile).

## Known issues and limits (by design for a learning project)

- **Trusted validators.** This is a multisig-style bridge: if 2 of the 3 validators collude or are hacked, they can deliver fake messages. This is exactly how the Ronin ($625M) and Harmony ($100M) bridges were drained. Real systems use more, independent validators, or avoid trust with **light clients / ZK proofs**, or (for rollups) the canonical bridge with fraud proofs and a 7-day challenge window.
- **Finality.** 2 confirmations is fine on a local chain. On Ethereum, wait for finality (~13 minutes); on an optimistic rollup, an L2 → L1 message is only final after the challenge period.
- **Who pays.** A real messenger charges a delivery fee on the source chain (like CCIP or LayerZero). Here the relayer simply limits what it pays for (F-2).
- **Fixed validator set, single owner.** No validator rotation; the owner (pause, `setRemote`) should be a multisig with a timelock.
- **Messages only, no tokens.** Moving value (lock-and-mint) adds risks like minting without a lock and supply mismatches; out of scope for today.
- **The cost model is a model.** Gas and signed bytes are real; prices are stated assumptions using the OP Stack Bedrock L1 data fee. Today's blob-based fees (EIP-4844) are lower still.

## Final green output

```
$ npm test
  Day 26 — Messenger and CrossChainTodo (two chains)  23 passing
  Day 26 — the two-chains page in a browser            4 passing
  Day 26 — fuzzing                                     2 passing
      fuzz: 150 tamperings → 150 refused; 30 sequences, 209 commands, 51 deliveries, 51 replays refused
  Day 26 — validators, relayer and the L2 cost model   9 passing

  38 passing (32s)

$ npm run planted-bugs
21 of 21 planted bugs caught

$ npm run demo
   9 of 9 refused

$ npm audit --omit=dev        found 0 vulnerabilities
$ npx solhint 'contracts/**/*.sol'   (no problems)
$ slither . --hardhat-ignore-compile
INFO:Slither:. analyzed (16 contracts with 101 detectors), 0 result(s) found
```
