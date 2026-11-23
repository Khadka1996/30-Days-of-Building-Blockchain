# Day 24 — QA and security review

**Scope:** the Sign-in-with-Ethereum server (`auth/server.js`, `auth/siwe-check.js`), the page (`public/src/app.js`) and the new `SmartWallet.sol` (ERC-1271). `TodoList.sol` is the Day 1 contract, copied **unchanged** (its tests live in `day-01/`).

**Security focus (ROADMAP):** signature replay and phishing. A login signature is a small, valuable thing: if an attacker can reuse it (replay) or collect it on a fake site (phishing), they *are* the user. So the question for every test: *can a signature made for anything other than this exact login, on this exact site, right now, get anyone in?*

## How it was tested

| Layer | Tool | What it covers |
|---|---|---|
| Contract | Hardhat + chai (4 tests) | ERC-1271 answers, junk and malleable (high-s) signatures, owner-only `execute` |
| Server | Hardhat + real HTTP (28 tests) | Normal and smart-wallet sign-in, cookies, logout, expiry, 7 replay attacks, 4 phishing / CSRF attacks, tampered and junk input, DoS caps, file serving |
| Browser | Playwright + Chromium (6 tests) | Fake wallet (keys in Node, returns lower-case addresses like MetaMask), rejected signature, wrong chain, XSS in task text, `HttpOnly`, an **evil site in the same browser** trying to use the session |
| Fuzz | fast-check (2 properties, 550 runs) | 150 random single-character edits of a signed message → all refused, and the nonce burned. 400 random mixes of domain / URI / chain / nonce / times → the server must agree with a 6-line reference model |
| Test of the tests | `npm run planted-bugs` | 12 real security bugs planted one at a time; the suite must fail for each |
| Tooling | npm audit · solhint · Slither | Dependencies, lint, static analysis |

## Findings (found and fixed during QA)

| ID | Severity | Found by | Description | Fix | Proving test |
|---|---|---|---|---|---|
| F-01 | Low | Test (`rejects junk input`) | **A too-big login body dropped the connection instead of answering 413.** `readJson` called `req.destroy()`, so the client saw "other side closed" and no error message; a buggy client might retry forever. | Stop storing the body, answer **413** with `Connection: close`, drain the rest. | `auth.test.js` › rejects junk input without crashing (failed with `fetch failed … other side closed` before the fix) |
| F-02 | Low | Manual review → test | **Unlimited sessions per address.** Anyone with a key can log in again and again; every login added a session to memory until it expired (1 h), so one key could grow the server's memory without limit. | At most **5 sessions per address**; a 6th login ends the oldest. | `auth.test.js` › one address can hold at most 5 sessions (failed with `expected 6 to have a length of 5` before the fix) |
| F-03 | Info | Slither `missing-zero-check` | `SmartWallet.execute(0x0, value, …)` "succeeds" (a call to an empty address does nothing) and would silently burn ETH. | `revert ZeroTarget()` | `SmartWallet.test.js` › refuses a zero owner and reverts when the inner call fails |
| I-01 | Info (test) | Planted bugs (`SessionFixation` **missed** on the first run) | The "fresh session id" test compared the session to the **wrong** pre-login cookie (it fetched a second nonce), so a server that reused the pre-login id as the session id still passed. | Test now logs in with the exact pre-login cookie it compares against. | Planted `SessionFixation` is now caught |
| I-02 | Info (test) | Fuzz stats | The field-combination fuzz produced only 5 valid logins in 300 runs, so the "accept" side was barely tested. Also, time offsets could land exactly on a limit (flaky by 1 ms). | The right value is weighted more (≈ 1 in 9 runs valid: 42/400), times use 10 s steps offset by 5 s, and the test asserts at least one acceptance. | `fuzz.test.js` › random field combinations |

No high or medium findings were left.

## Built-in defences (each one has a test, and a planted bug proves the test can fail)

| ID | Attack | Defence | Proving test | Planted bug caught |
|---|---|---|---|---|
| D-01 | **Ambiguous message**: a second `Nonce:` or `URI:` line hidden in the text; lower-case address | viem's parser ignores extra lines (shown in the test). We rebuild the message from the parsed fields and require it to be **byte-for-byte** the signed text; the address must be EIP-55 checksummed | a smuggled second 'Nonce:' line is refused · a lower-case address is refused | `LenientParser` |
| D-02 | **Phishing**: a fake site collects a signature and replays it here | `domain` must equal our host (port included), `URI` must be on our origin. `localhost` ≠ `127.0.0.1`, other ports are other sites | phishing-site signature · look-alike domain or port · URI on another site | `NoDomainCheck`, `NoUriCheck` |
| D-03 | **Replay / race**: send the same signature twice, or 5 times at once | The nonce is deleted **before the first `await`**, so it gets exactly one try; a failed try also burns it | the same message cannot be used twice · 5 racing requests: exactly one wins · a failed attempt burns the nonce | `NonceNeverBurned`, `NoNonceCheck` |
| D-04 | **Stolen signature** used in the attacker's browser | Each nonce is bound to the browser that asked for it (random `HttpOnly` pre-login cookie) | a stolen message + signature is useless in the attacker's browser | `NoNonceCheck` |
| D-05 | **Old or cross-chain signatures** | Nonce lives 5 min; `Issued At` within 5 min (±60 s clock skew); `Expiration Time` and `Not Before` honoured; chain ID must be 31337 | nonce expires · expired / future / old / not-yet-valid · another chain | `NoExpiryCheck`, `NoChainCheck` |
| D-06 | **Login CSRF** (another site logs you in as the attacker) and cross-site use of your session | POSTs need our exact `Origin` and `Content-Type: application/json`; cookies are `SameSite=Strict`; no CORS headers | wrong or missing Origin · browser: evil site gets no cookie, can't read `/api/me`, can't log you out | `NoOriginCheck` |
| D-07 | **Smart-wallet users locked out**, or a wallet that says "yes" to junk | `viem.verifyMessage` checks normal keys *and* ERC-1271 wallets. `SmartWallet` uses `ECDSA.tryRecover` (rejects malformed and high-s signatures, never reverts) | smart wallet signs in · non-owner refused · junk and malleable signatures | `EcrecoverOnly` |
| D-08 | **Session theft / fixation** | 256-bit random session id, new on every login; `HttpOnly` (scripts can't read it); deleted on the server at logout; ends at min(1 h, message expiry); max 5 per address | cookie flags · copied cookie dead after logout · session expiry · `document.cookie` is empty | `SessionFixation`, `LogoutKeepsSession`, `NoSessionCap` |

Also checked: XSS through task text (shown with `textContent`, strict CSP `script-src 'self'`, 0 dialogs), path traversal (`/../package.json`, `/%2e%2e/…`, `/auth/server.js` → 404), unused-nonce flood (capped at 10,000, then 503 until they expire), nonces (32 hex chars from `crypto.randomBytes`, 50/50 unique).

## Static analysis and dependencies

- `npm audit --omit=dev`: **0 vulnerabilities** (the only runtime dependency is `viem`).
- `solhint`: 0 problems (one `immutable-vars-naming` rule disabled on `owner`, so the getter keeps the standard name `owner()`).
- `slither`: 2 notes, both intended:
  - `unused-return` on `ECDSA.tryRecover`: the third value is extra error data; the error *kind* is checked.
  - `low-level-calls` in `SmartWallet.execute`: a wallet must be able to call anything; owner-only, zero target refused, failure reverts.

## Known issues and limits

- **Sessions live in memory.** A restart logs everyone out, and two server instances would not share sessions. A real app keeps sessions and nonces in Redis or a database (with the same "delete on first use" rule, done atomically).
- **No rate limit per IP.** Each login attempt for a smart wallet costs one `eth_call`. Put the server behind a reverse proxy with rate limiting.
- **Trusts one RPC node** for smart-wallet checks; a lying node could say "valid". Use your own node or a trusted provider.
- **Local development cookies.** On `http://127.0.0.1` cookies can't be `Secure`, and cookies are shared by every port on the same host. In production: HTTPS only, the server adds `Secure` automatically for `https://` origins, and a `__Host-` cookie name is recommended.
- **Strict formatting.** Messages must be exactly what viem's `createSiweMessage` produces (e.g. times with milliseconds). Another SIWE library that formats times differently would be refused: safe, but less flexible.
- **ERC-6492** (signatures from not-yet-deployed smart wallets) is accepted through viem; it only runs as a simulated `eth_call`, never a real transaction.

## Final run (fresh)

```
$ npm test
  SmartWallet (ERC-1271)                       4 passing
  Day 24 — Sign in with Ethereum server
    happy paths                                6 passing
    signature replay                           7 passing
    phishing                                   4 passing
    tampered or malformed messages             5 passing
    server hygiene                             6 passing
  Day 24 — sign-in page in the browser         6 passing
  Day 24 — fuzzing the login
    ✔ any edit to a signed message (insert, delete or change a character) is refused
    ✔ random field combinations: accepted if and only if every field is right
      fuzz stats: {"mutated":150,"fieldCombos":400,"accepted":42,"replays":150}
  40 passing (6s)

$ npm run planted-bugs
NoDomainCheck        CAUGHT     NoUriCheck           CAUGHT     NoChainCheck         CAUGHT
NoNonceCheck         CAUGHT     LenientParser        CAUGHT     NoExpiryCheck        CAUGHT
NonceNeverBurned     CAUGHT     NoOriginCheck        CAUGHT     SessionFixation      CAUGHT
LogoutKeepsSession   CAUGHT     EcrecoverOnly        CAUGHT     NoSessionCap         CAUGHT

$ npm run demo
Alice signs in (normal wallet)             200  signed in as 0xf39Fd6e5…
Smart wallet signs in (ERC-1271)           200  signed in as 0xe7f1725E…
Replay Alice's signature                   401  Sign-in refused: unknown or used nonce
Mallory uses a stolen signature            401  Sign-in refused: unknown or used nonce
Phishing-site signature (evil.example)     401  Sign-in refused: wrong domain: evil.example
Message for another chain (ID 1)           401  Sign-in refused: wrong chain ID: 1
Smuggled 2nd 'Nonce:' line                 401  Sign-in refused: message is not in exact EIP-4361 form
Mallory signs as Alice with her own key    401  Sign-in refused: signature does not match the address
Login posted from another site             403  Cross-site request refused
2 real sign-ins accepted · 7 of 7 attacks refused

$ npm audit --omit=dev            found 0 vulnerabilities
$ npm run lint                    0 problems
$ slither . --hardhat-ignore-compile
  2 results: unused-return (tryRecover), low-level-calls (SmartWallet.execute) — both intended
```
