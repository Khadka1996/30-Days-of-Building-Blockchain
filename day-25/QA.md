# Day 25 — QA and security review

**Scope:** `contracts/Forwarder.sol` (EIP-712 meta-transactions, ERC-2771), `contracts/GaslessTodoList.sol` (the Day 1 to-do list with `msg.sender` → `_msgSender()`), the relayer (`relayer/server.js`) and the page (`public/app.js`). The test-only contracts in `contracts/test/` are deliberately hostile targets.

**Security focus (ROADMAP):** relayer abuse and nonce reuse. Two different victims:
- **the user**: can anyone run their signed request twice, change it, run it on another chain, or make it "succeed" without doing the work?
- **the relayer**: it pays the gas, so can anyone make it pay for failures, for other apps, for spam, or make it send ETH?

## How it was tested

| Layer | Tool | What it covers |
|---|---|---|
| Contracts | Hardhat + chai (19 tests) | Gasless add / complete / delete from a 0-ETH user, replay, nonce order, same-nonce twins, other chain / other forwarder, forged `from`, tampered fields, junk and high-s signatures, expiry, sender spoofing, untrusted targets, value, **gas griefing scan** (101 gas limits), **return bomb**, junk trust answers |
| Relayer | Hardhat + real HTTP (17 tests) | Every refusal is checked to cost the relayer **0 transactions**: replay, 5 racing copies, future nonce, would-revert, forged signature, other app, read-only function, value, gas cap, deadline horizon, rate limit, quota theft, junk input, queue cap, static files |
| Browser | Playwright + Chromium (4 tests) | Fake 0-ETH wallet (`eth_signTypedData_v4`), add / complete / delete, cancelled signature, wrong network, XSS in task text |
| Fuzz | fast-check (2 properties) | 150 random tamperings of a signed request (any field or signature byte) → all refused, 0 paid transactions. 40 random sequences (≈200 commands) of good, replayed, future, expired, failing and same-nonce requests from 2 users → nonces, task counts and the relayer's paid transactions match a small model exactly |
| Test of the tests | `npm run planted-bugs` | 20 real bugs planted one at a time (10 on-chain, 9 relayer, 1 page); the suite must fail for each |
| Tooling | npm audit · solhint · Slither | Dependencies, lint, static analysis |

## Findings (found and fixed during QA)

| ID | Severity | Found by | Description | Fix | Proving test |
|---|---|---|---|---|---|
| F-01 | **Medium** | Test (gas griefing scan) | **An under-funded relay could "succeed" without doing the work.** My first version used the common *after-the-call* 63/64 check (`gasleft() < req.gas / 63` → `invalid()`). That check assumes the inner call used up all its gas. A target that keeps some gas back and catches its own out-of-gas error (common in clean-up code) returned "success" while its real work failed, and the user's nonce was spent. The scan failed at an outer gas limit of 100,000; with no check at all it failed the same way. | Check **before** the call that the full `req.gas` will really be passed on: `gasleft() >= req.gas × 64/63 + 15,000`, else `revert NotEnoughGas` (nothing is spent, the user can retry). | `Forwarder.test.js` › insufficient-gas griefing (both the old check and no check fail it; planted `NoGasCheck` caught) |
| F-02 | Low | Slither `return-bomb` | **Return bomb.** `execute` copied all of the target's return data, and `_trusts` all of `isTrustedForwarder`'s answer. A hostile target can return hundreds of KB, and the caller (the relayer) pays to copy it. | The call copies **no** return data; a revert reason is cut to 256 bytes; the trust check reads exactly 32 bytes. `execute` no longer returns data. | `Forwarder.test.js` › a target that returns 200 KB… (forwarder overhead < 60k gas, revert data = 256 bytes; planted `UncappedRevertData` caught) |
| F-03 | Info | Slither `reentrancy-events` | `Executed` was emitted after the external call, so a re-entrant request could log in the wrong order. | Emit before the call (a failed call reverts the event too). | Slither clean; `Forwarder.test.js` › a user with 0 ETH adds a task (event args) |
| I-01 | Info (test) | Test (`would revert` gave "An unknown RPC error") | The in-process Hardhat provider throws reverts without JSON-RPC code `3`, so viem couldn't decode them and the relayer's refusal message was useless. | Test adapter adds code 3 like a real node; the relayer now runs `eth_call` (simulate) before estimating gas, so the reason is decoded (`would fail on-chain: EmptyText`). | `relayer.test.js` › a request that would revert… |
| I-02 | Info (test) | Comparing fixes | My first griefing target cost a different amount of gas each run (storage and memory effects), so the scan passed even with **no** gas check: the test could not fail. | Deterministic target that reserves 20k gas for itself; verified the test fails with no check and with the after-call check, and passes with the fix. | Planted `NoGasCheck` caught |

No high or medium findings were left.

## Built-in defences (each one has a test, and a planted bug proves the test can fail)

| ID | Attack | Defence | Proving test | Planted bug caught |
|---|---|---|---|---|
| D-01 | **Nonce reuse / replay** | Sequential nonce per user; must equal the next one; spent **before** the call | same request twice · future nonce · same-nonce twins · fuzz model | `NoNonceCheck`, `NonceNotSpent` |
| D-02 | **Acting as someone else / changing a request** | EIP-712 signature over every field, `ECDSA.tryRecover` (rejects high-s and junk) | forged `from` · changed text, gas, deadline · 150 fuzz tamperings | `NoSignerCheck`, `DataNotSigned` |
| D-03 | **Replay on another chain or forwarder** | Domain = name, version, **chain ID**, **forwarder address** | another chain / another forwarder | `DataNotSigned` (shared digest) |
| D-04 | **Holding a signature for later** | Deadline on-chain; relayer refuses deadlines > 1 h ahead | expired · 1-year deadline | `NoDeadlineCheck`, `NoDeadlineHorizon` |
| D-05 | **Sender spoofing** | `_msgSender()` trusts the appended address **only** from the one forwarder; forwarder only calls targets that answer exactly `true` to `isTrustedForwarder` | direct call with victim's address appended · plain target · empty address · junk answers | `NoTrustCheck`, `TrustAnyAnswer` |
| D-06 | **Relayer pays for failures** | Off-chain signer check, on-chain `verify`, then simulate (`eth_call`) **inside the one-at-a-time queue**; only then send | would-revert · future nonce · 5 racing copies → 1 tx · fuzz: paid tx = accepted | `NoPreflight` |
| D-07 | **Relayer pays for other things** | Only our to-do contract, only `addTask` / `completeTask` / `deleteTask`, value 0, gas ≤ 300,000 | other app · read-only function · value · gas cap | `NoTargetPolicy`, `NoSelectorPolicy`, `NoValuePolicy`, `NoGasCap` |
| D-08 | **Relayer forced to send ETH** | On-chain `msg.value == req.value`; relayer policy value = 0 | value mismatch · value > 0 | `NoValueCheck`, `NoValuePolicy` |
| D-09 | **Spam** | 10 relays / signer / minute, counted **after** the signature check (so forgeries can't use up a victim's quota); queue cap 50 → 503 | rate limit · quota theft · queue full | `NoRateLimit`, `QuotaBeforeSigCheck`, `NoQueueCap` |
| D-10 | **Gas griefing / return bomb** | See F-01, F-02 | griefing scan · return bomb | `NoGasCheck`, `UncappedRevertData` |
| D-11 | **XSS** | Task text via `textContent`, CSP `script-src 'self'` | XSS test (0 dialogs, 0 `<img>`) | `XssInnerHtml` |

Also checked: junk JSON, wrong types, leading-zero and negative numbers, oversized data and body (413), unknown fields, path tricks on static files (fixed allow-list), wrong network in the page (wallet never asked to sign), cancelled signatures (nothing sent).

## Static analysis and dependencies

- `npm audit --omit=dev`: **0 vulnerabilities** (the only runtime dependency is `viem`).
- `solhint`: **0 problems**. Inline assembly in `Forwarder.sol` is marked and explained (it is the fix for F-02); test-only contracts disable lint on purpose.
- `slither`: **3 notes, all `assembly`** (the three small blocks that avoid copying return data). Intended.

## Known issues and limits

- **The relayer is a cost centre.** It pays for every accepted request and only rate-limits; a real service also sets a daily gas budget per user, charges a fee (e.g. in a token) or uses an ERC-4337 paymaster, and refills a hot wallet holding little ETH.
- **In-memory state.** Rate limits and the in-flight set reset on restart and aren't shared by two relayer instances (use Redis). The in-flight lock is extra safety: the queue re-checks on-chain anyway (removing the lock alone is not caught by a test, by design).
- **One transaction at a time.** Simple and safe for the relayer's own nonce, but slow. Production relayers manage nonces and speed up stuck transactions.
- **Censorship and front-running.** A relayer can refuse to relay (it can never change or steal a request); the user can then use another relayer or pay their own gas. Anyone who sees a signed request in the mempool can submit it first: the result is the same, but the relayer's copy reverts and costs it gas. Real relayers use private transaction pools.
- **Sequential nonces.** A request that never gets sent blocks later ones; the user re-signs with the same nonce. Parallel "nonce lanes" (as in ERC-4337) avoid this.
- **Never add `Multicall`** to an ERC-2771 contract (OpenZeppelin advisory, Dec 2023): batched calls through the forwarder break the "last 20 bytes" rule.
- Revert reasons longer than 256 bytes are cut (normal custom errors are 4–100 bytes).

## Final run (fresh)

```
$ npm test
  Forwarder + GaslessTodoList (on-chain rules)
    gasless happy path                          3 passing
    nonce reuse and replay                      5 passing
    forged and tampered requests                4 passing
    sender spoofing (ERC-2771)                  3 passing
    relayer must play fair                      2 passing
    hostile targets                             2 passing
  Day 25 — gasless page in the browser          4 passing
  Day 25 — fuzzing the forwarder and relayer
    ✔ any change to a signed request (any field, or the signature) is refused, and costs the relayer nothing
    ✔ random sequences of good, replayed, out-of-order, expired and failing requests match the model
      fuzz stats: {"tampered":150,"sequences":40,"commands":186,"relayed":75,"refused":79}
  Day 25 — relayer server
    happy path                                  2 passing
    nonce reuse                                 3 passing
    relayer abuse                              12 passing
  42 passing (12s)

$ npm run planted-bugs
NoNonceCheck         CAUGHT   NonceNotSpent        CAUGHT   NoDeadlineCheck      CAUGHT
NoSignerCheck        CAUGHT   DataNotSigned        CAUGHT   NoTrustCheck         CAUGHT
TrustAnyAnswer       CAUGHT   NoGasCheck           CAUGHT   NoValueCheck         CAUGHT
UncappedRevertData   CAUGHT   NoPreflight          CAUGHT   NoTargetPolicy       CAUGHT
NoSelectorPolicy     CAUGHT   NoValuePolicy        CAUGHT   NoGasCap             CAUGHT
NoDeadlineHorizon    CAUGHT   NoRateLimit          CAUGHT   QuotaBeforeSigCheck  CAUGHT
NoQueueCap           CAUGHT   XssInnerHtml         CAUGHT
20 of 20 planted bugs caught

$ npm run demo
User adds 'Pay electricity bill' (0 ETH)       200  relayed, gas 185929
User adds 'Buy momo for the team'              200  relayed, gas 134665
User completes task 1                          200  relayed, gas 63545
Replay the user's first request                400  not valid on-chain: nonce already used, expired, or bad signature
Mallory signs, claims to be the user           401  signature does not match the request
Change the task text after signing             401  signature does not match the request
Signed for another chain (ID 1)                401  signature does not match the request
Make the relayer pay for another app           403  this relayer only pays for the to-do contract
Make the relayer send 1 ETH                    403  value must be 0: the relayer never sends ETH for you
Ask for 10,000,000 gas                         403  gas must be at most 300000
Signature valid for 1 year                     403  deadline must be within 3600 s
Request that would revert (empty task)         400  would fail on-chain: EmptyText
User's ETH: 0.0 · relayer paid 0.000600513868655162 ETH for 3 transactions
Transactions sent for the attacks: 0
3 gasless actions done · 9 of 9 attacks refused

$ npm audit --omit=dev            found 0 vulnerabilities
$ npm run lint                    0 problems
$ slither . --hardhat-ignore-compile
  3 results: assembly (Forwarder.execute, _trusts, _returnDataUpTo) — intended, see F-02
```
