# Day 22 — QA and security review

**Scope:** the new web app in `app/` (Next.js 16, wagmi 3, viem 2) and the deploy script. The contracts are the Day 1 `TodoList` and Day 2 `PiggyBank`, copied **unchanged** with their original tests (`contracts/test/` holds Day 2's test-only helpers).

**Security focus (ROADMAP):** wrong network and rejected transactions. I widened "rejected" to every way a transaction can fail *after* the user clicks: rejected in the wallet, refused by the contract, cancelled or replaced from the wallet, dropped from the mempool, not enough ETH.

## How it was tested

| Layer | Tool | What it covers |
|---|---|---|
| Contracts | Hardhat + chai + fast-check | The 37 Day 1/Day 2 tests, re-run on the copies |
| Safety logic | `node --test` (8 tests) | `lib/guards.js`: network check, error classifier (rejected / wrong network / cancelled / timeout / no funds / custom-error decoding), task text in **bytes**, deposit parsing |
| Whole app | Playwright (17 tests) | Real Chromium, the production build, a local Hardhat node and a **test wallet** (`e2e/wallet.js`): a real EIP-1193 provider at `window.ethereum` that can switch chains (loudly or silently), reject connects, switches and transactions, and records every `eth_sendTransaction` the app asks for |
| Tooling | npm audit · solhint · Slither | Dependencies, lint, static analysis |

Each test snapshots the chain and reverts it afterwards, so tests never see each other's data.

## Findings

| ID | Severity | Found by | Description | Fix | Proving test |
|---|---|---|---|---|---|
| F-01 | High | Review + e2e | **Fake "Done".** If the user presses *Cancel* (or *Speed up* with a different action) in their wallet, the wallet sends a new transaction with the same nonce. viem's receipt waiter then returns the **replacement's** receipt, which succeeded, so the app showed "Delete: Done ✓" although the task was never deleted. | `waitForTransactionReceipt` gets an `onReplaced` callback. A `repriced` replacement (same action, higher fee) is fine; `cancelled` or `replaced` throws, and the app says the action did not run. | `dapp.spec.js` › transaction cancelled from the wallet (failed with `Received: "success"` before the fix) |
| F-02 | Medium | e2e | **Stuck forever.** A transaction dropped from the mempool is never mined. The app waited with no limit, so the panel stayed on "Waiting for the block…" and every button stayed locked until a page reload. | Receipt wait has a timeout (120 s, `NEXT_PUBLIC_TX_TIMEOUT_MS`); then the app unlocks, keeps the typed text and tells the user to check the wallet's activity before retrying. | `dapp.spec.js` › transaction dropped and never mined (stayed `pending` before the fix) |
| F-03 | Medium | e2e | **Wallet pop-up for a payment that cannot work.** The pre-flight simulation (`eth_call`) does not check the sender's balance, so depositing 50,000 ETH from a 10,000 ETH account passed the dry run and opened the wallet. | Before any payable call the app reads the balance from its own RPC and stops with "Your wallet does not have enough ETH…". | `dapp.spec.js` › more ETH than you own (sent 1 transaction before the fix, 0 after) |
| F-04 | Low | e2e (found while taking screenshots) | After one successful add, the "clear the box" code ran on **every** render while the status said "Done", so the next task you typed was erased letter by letter. Same for the deposit amount after a top-up. | The input is cleared once, by an `onSuccess` callback that runs in the same render as "Done". | `dapp.spec.js` › two tasks in a row, then a top-up |
| F-05 | Low | Review | No Content-Security-Policy: any injected script could send data to any server. | Production CSP: `connect-src 'self' <RPC>`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`; plus `X-Frame-Options: DENY`, `nosniff`, no `X-Powered-By`. | `dapp.spec.js` › security headers |
| T-01 | Info (test bug) | Unit test | My first byte-length test used 🛠️, assuming 4 bytes. It is **7** (a 4-byte emoji + a 3-byte style selector). The contract counts bytes, so the app does too; the test now uses 😀 (4 bytes): 70 fit, 71 do not. | Test fixed; the app code was right. | `guards.test.js` › validateTaskText |
| T-02 | Info (test setup) | Debugging F-04 | Next 16 names its process `next-server`, so `pkill -f "next start"` missed it and Playwright reused an **old build**. Results looked wrong until the port was freed. | Free the port (`fuser -k 3000/tcp`) before a test run; the final run below is on a fresh build and a fresh chain. | — |

### Checked and already safe (tests kept as guards)

| Attack / mistake | Result | Test |
|---|---|---|
| Wallet on another chain (mainnet) | Red banner, every write button disabled, one-click switch; **nothing** is ever sent on chain 1 | wrong network |
| Wallet changes chain mid-session | Banner appears at once, writes lock | wallet changes network mid-session |
| Wallet changes chain **silently** (no `chainChanged` event) | Before every write the app asks the wallet `eth_chainId` live, and the send is pinned to chain 31337: blocked, 0 transactions sent. (wagmi's own chain pin also catches this; we keep both layers.) | silent network change |
| User rejects the switch / the connect / a transaction | Plain message, nothing changes, text kept, buttons unlock, retry works | rejected network switch · rejected connect · rejected transaction |
| Contract would revert (withdraw while locked) | Caught by simulation, decoded to "still locked", **no wallet pop-up** | piggy bank |
| Right chain ID but contracts missing (node restarted) | `eth_getCode` check: "contracts are not on this chain", writes blocked | contracts missing |
| HTML/JS in a task (`<img onerror=…>`) | Shown as text by React; nothing runs | task text is shown as text |
| Double click | One transaction (a ref lock, set before React re-renders) | double click |
| Bad amounts (`-1`, `1e18`, `0`, 19 decimals, 99,999 days) | Rejected in the form; 0 transactions | bad form input |

Design choices that matter for safety: **reads never go through the wallet** (they use the app's own RPC for chain 31337), so a wallet on the wrong chain can never make the page show wrong balances; the deploy script refuses any chain but 31337.

## Static analysis and dependencies

- `npm audit --omit=dev`: **0 vulnerabilities** (contracts package and app). I first tried Next 15 + wagmi 2: wagmi 2 pulls in the WalletConnect/MetaMask SDKs and Next 15 an old `postcss`, **29 audit findings** (17 high). Next 16 + wagmi 3 (connectors are optional) brought it to 0.
- `solhint`: 0 errors, 0 warnings.
- `slither`: 1 note, `low-level-calls` in `PiggyBank.withdraw` — the intended `call{value:}` from Day 2 (checks → effects → interaction, tested against re-entrancy there).

## Known issues and limits

- **The wallet's RPC is not the app's RPC.** Reads come from the app's node; the wallet sends through its own. A wallet pointed at a *different* chain that also uses ID 31337 would pass the network check. On real networks chain IDs are unique; for local work, use one node.
- **Leaving the page forgets a pending transaction.** The wallet still has it; the page shows the new state after it is mined and you reload.
- **CSP allows `'unsafe-inline'` scripts**, which Next's static pages need for their bootstrap. A nonce-based CSP needs server rendering on every request.
- **Tested with a test wallet, not MetaMask.** The test wallet follows EIP-1193 (the same calls and error codes MetaMask uses). A manual MetaMask check is in the README.

## Final run (fresh chain, fresh production build)

```
npm test                    # contracts + unit
  37 passing (4s)
# pass 8
# fail 0

npm run test:e2e
  ✓   1 happy path: connect, add, complete and delete a task (1.1s)
  ✓   2 two tasks in a row, then a top-up: inputs keep what you type (1.0s)
  ✓   3 wrong network: banner, every write blocked, one click to switch (616ms)
  ✓   4 rejected network switch: stays blocked, explains why (481ms)
  ✓   5 right chain id but contracts missing (e.g. node restarted): writes blocked (392ms)
  ✓   6 wallet changes network mid-session: banner appears, writes lock (380ms)
  ✓   7 silent network change (no event): the live check still refuses to send (503ms)
  ✓   8 rejected transaction: clear message, nothing changes, retry works (715ms)
  ✓   9 rejected connect: friendly message, still disconnected (306ms)
  ✓  10 piggy bank: a locked withdraw is caught before the wallet opens; works after unlock (4.8s)
  ✓  11 bad form input never reaches the wallet (809ms)
  ✓  12 task text is shown as text, never run as HTML (574ms)
  ✓  13 double click sends only one transaction (1.1s)
  ✓  14 more ETH than you own: plain-words message, nothing sent (470ms)
  ✓  15 transaction cancelled from the wallet: no fake 'Done', task still there (2.0s)
  ✓  16 transaction dropped and never mined: the page stops waiting and says so (6.8s)
  ✓  17 security headers: CSP limits where the page can connect, no framing (26ms)
  17 passed (28.7s)

npm audit --omit=dev        found 0 vulnerabilities   (root and app/)
npx solhint 'contracts/**/*.sol'   no problems
slither . --hardhat-ignore-compile   1 result (low-level-calls, intended)
```
