# Day 23 — QA and security review

**Scope:** the new event indexer (`indexer/indexer.js`, `indexer/store.js`), the feed server (`indexer/server.js`) and the feed page (`public/`). The contracts are the Day 1 `TodoList` and Day 2 `PiggyBank`, copied **unchanged** (their own tests live in `day-01/` and `day-02/`).

**Security focus (ROADMAP):** chain reorganisations and missed events. An indexer has one job: *the index must equal the chain*. Two ways to fail: an event that is on the chain but not in the index (**missed**), or an event in the index that is no longer on the chain (**ghost**, left behind by a reorg).

## How it was tested

| Layer | Tool | What it covers |
|---|---|---|
| Indexer | Hardhat + mocha (18 tests) | Decoding, confirmations, range-limited RPC, RPC errors, restarts, a block mined mid-sync, redeploys, 5 kinds of reorg, a node restart |
| Indexer | fast-check (200 random runs) | Random users, tasks, deposits, empty blocks, **reorgs** (`evm_snapshot`/`evm_revert`), **restarts**, through an RPC that refuses more than 4 blocks per `eth_getLogs`. After **every** sync: index == every log on the current chain |
| Test of the tests | 6 planted bugs | 5 broken indexers run through the same fuzz, 1 through the mid-fetch test: all 6 must be caught |
| Feed | Playwright + Chromium (6 tests) | Live updates, pending → confirmed, a reorg on screen, XSS payloads, chain down at start-up, headers and file serving |
| Tooling | npm audit · solhint · Slither | Dependencies, lint, static analysis |

Reorgs are real on the local chain: `evm_snapshot` marks a block, `evm_revert` throws away every block after it, and new transactions (with a later timestamp) build a **different** branch at the same heights — new block hashes, same numbers. That is exactly what an indexer sees on a real network.

## Findings

| ID | Severity | Found by | Description | Fix | Proving test |
|---|---|---|---|---|---|
| F-01 | Low | Manual run (`npm run feed` + timing script) | **The live feed lagged 2.7–3.7 s behind the chain** although it polls every second. viem's `getBlockNumber()` is cached for 4 s by default, so most polls re-used an old head. For a feed that also decides "pending vs confirmed", a stale head means stale confirmations. | The indexer reads the head with a raw `eth_blockNumber` request (no cache, whatever the client settings); the server's client also sets `cacheTime: 0`. Measured lag after the fix: **0.3–0.7 s**. | `indexer.test.js` › sees a new block on the very next sync (failed with `expected +0 to equal 1` before the fix) |
| F-02 | Low | Review → test | **Feed server crashed at start-up when the chain was down.** `listen()` called `indexer.init()` (which asks the chain for its ID) outside the error handling, so an unreachable RPC was an unhandled rejection. | `listen()` no longer calls `init()`; the first `sync()` does it inside the guarded poll loop. The page loads and shows "Indexer can't reach the chain…", and recovers by itself when the node is back. | `feed.e2e.test.js` › starts even when the chain is down (failed with `UnknownRpcError … ECONNREFUSED` before the fix) |
| I-01 | Info | First test run (4.3 s for one test) | viem **retries** "limit exceeded" (`-32005`) errors 3 times with back-off before the indexer sees them, so every halving of the range cost ~1 s. | Kept viem's retries for real networks (they help with flaky RPCs); the shrunken range is remembered for the rest of the run, so the cost is paid once. Tests use `retryCount: 0`. | `indexer.test.js` › splits a big backfill (now < 0.1 s) |

No high or medium findings were left. The core reorg and missed-event logic passed its tests the first time it ran, so I checked that the tests themselves can fail (next section).

## The tests can catch the bugs that matter (planted bugs)

| Planted bug | What it does wrong | Caught by | How it showed up |
|---|---|---|---|
| `NoReorgCheck` | Never checks block hashes | fuzz | 4 ghost events: "indexed 4 events, chain has 0" |
| `RewindKeepsGhosts` | Rewinds the cursor after a reorg but keeps the orphaned events | fuzz | 4 ghost events |
| `OffByOne` | Starts each range one block late | fuzz | 1 missed event: "indexed 3, chain has 4" |
| `SkipsRefusedRange` | When the RPC refuses a range, skips it instead of splitting | fuzz | 2 missed events: "indexed 0, chain has 2" |
| `HeightOnly` | Detects reorgs only when the head goes backwards | fuzz | 1 ghost event |
| `NoDoubleRead` | Reads block `to` only once, after its logs | mid-fetch reorg test | the orphan stays in the index forever |

## Checked and already safe (tests kept as guards)

| Attack / failure | Result | Test |
|---|---|---|
| Reorg replaces the last blocks | Orphaned events deleted, new branch indexed, reorg shown on the page with the removed events struck through | removes events from orphaned blocks · shows a reorg |
| Reorg to a **shorter** chain | Walks back past the missing blocks | handles a reorg to a SHORTER chain |
| Reorg with the **same height** (only old blocks differ) | Caught by the hash of the cursor block; block numbers alone would miss it | detects a reorg that only changes OLD blocks |
| Reorg deeper than the 128 saved hashes | Falls back to a full re-index: slow, never wrong | re-indexes from the start |
| Chain reorganises **while** a range is being read | Block `to` is read before and after its logs; if it changed, the range is thrown away and re-read | discards a range whose last block changed |
| Node restarted (same chain ID, brand-new chain) | Saved hashes don't match → full re-index; no events from the old chain survive | recovers when the local node is restarted |
| RPC limits `eth_getLogs` ranges (Infura/Alchemy style) | Range halves until accepted; nothing skipped | splits a big backfill |
| Other RPC errors (connection reset) | Sync throws, cursor unchanged, next sync retries | does not swallow other RPC errors |
| Indexer down while people use the app | Restart resumes from the saved cursor; events + cursor saved in **one** atomic write (temp file + rename), ids are `blockHash:logIndex`, so no gaps and no duplicates | catches up after a restart |
| Block mined during a sync | Head is read **once**; ranges never use `latest`, so the new block is picked up next round | never skips a block mined while a sync is running |
| Look-alike contract with the same events | Logs are filtered by address | ignores events from other contracts |
| Saved index from another deployment | Detected (addresses / chain ID stored with the index); starts fresh | starts over when the saved index belongs to other contracts |
| HTML/JS in a task (`<img onerror>`, `<script>`, `<svg onload>`) | Shown as text (`textContent` only, never `innerHTML`); strict CSP `script-src 'self'`; 0 dialogs, 0 injected elements | task text is shown as text |
| RPC URL with an API key in an error | The feed only shows viem's `shortMessage` ("HTTP request failed."). The full `message` **does** contain the URL — checked: `message has key: true` | starts even when the chain is down (asserts the key never reaches the browser) |
| Reading other files / other sites reading the feed | Only 3 fixed files are served (no paths from the request); `/../package.json`, `/data/index.json` → 404; POST → 405; no CORS header; bound to 127.0.0.1 | serves only its own files |

## Static analysis and dependencies

- `npm audit --omit=dev`: **0 vulnerabilities** (the only runtime dependency is `viem`).
- `solhint`: 0 errors, 0 warnings.
- `slither`: 1 note, `low-level-calls` in `PiggyBank.withdraw` — the intended `call{value:}` from Day 2 (checks → effects → interaction, tested there).

## Known issues and limits

- **"Confirmed" is not "final".** 3 confirmations means a reorg is unlikely, not impossible. On Ethereum mainnet, wait for the `finalized` block tag (about 13 minutes) before treating an event as permanent (for example before shipping goods).
- **Trusts one RPC node.** A lying node can hide or invent logs. Real indexers use their own node or compare several providers.
- **JSON file store.** The whole index is rewritten after each range: fine for a demo, slow for millions of events. A real indexer uses a database with a transaction per range (SQLite, Postgres) and one writer per file.
- **Deep reorgs re-index everything.** Only the last 128 block hashes are kept; anything deeper starts over (correct, just slow).

## Final run (fresh)

```
$ npm test
  Day 23 — live feed in the browser
    ✔ shows new activity live, pending first, then confirmed
    ✔ shows a reorg: orphaned events disappear and are listed as removed
    ✔ task text is shown as text: HTML/JS in an event never runs
    ✔ says so when the chain is unreachable, and keeps the last good data
    ✔ starts even when the chain is down, and reports it instead of crashing
    ✔ serves only its own files, with strict security headers
  Day 23 — fuzzing the indexer
      2335 random actions · 926 txs · 160 reorgs · 140 restarts · 756 checked syncs · 0 mismatches
    ✔ index == chain after every sync (200 random runs)
    ✔ catches planted bug: NoReorgCheck
    ✔ catches planted bug: RewindKeepsGhosts
    ✔ catches planted bug: OffByOne
    ✔ catches planted bug: SkipsRefusedRange
    ✔ catches planted bug: HeightOnly
  Day 23 — event indexer
    (18 tests: reading events · missed events · chain reorganisations · helpers)
  30 passing (16s)

$ npm audit --omit=dev            found 0 vulnerabilities
$ npm run lint                    0 problems
$ slither . --hardhat-ignore-compile
  1 result: low-level-calls in PiggyBank.withdraw (intended, Day 2)

Manual run (npm run chain / deploy / activity / feed / demo:reorg)
  8 transactions → 8 events in the feed
  demo:reorg → "Chain reorganisation from block 17: 2 event(s) removed", 9 events after
  feed lag after a new block: 0.3–0.7 s (was 2.7–3.7 s before F-01)
```
