# Day 29 — QA and security review (Pramaan web app + deploy kit)

**Scope:** the web app in [`capstone/app/`](../capstone/app) (verifier page, institution portal, QR payload, CSV reader, local server) and the deploy kit ([`capstone/DEPLOY.md`](../capstone/DEPLOY.md), [`scripts/deploy.js`](../capstone/scripts/deploy.js), [`scripts/council.js`](../capstone/scripts/council.js)). The contract is unchanged since Day 28 and all its tests still run.

**Security focus (capstone, web side):** what would let a fake certificate *look* real in the browser, leak a student's details, or let an institution publish something it can't take back:
- can the page be tricked into showing **Valid** or the **wrong institution** for a fake?
- can text inside a QR code **run as code** (XSS), or a QR send people to a **look-alike site**?
- does any **personal data or salt** leave the browser?
- wrong network, rejected or **double-sent transactions**, lost salts, a down RPC.

## How it was tested

| Layer | Tool | What it covers |
|---|---|---|
| Contract + library (Day 28) | Hardhat + chai, fast-check | 38 tests, unchanged and green |
| QR payload + CSV | mocha (9 tests) + fast-check (2 properties) | Round trip recomputes the same hashes; strict decoding (version, ids, field lengths, salt length, proof length, garbage); link parsing; CSV quotes/commas/new lines/CRLF/BOM/Devanagari; any column order; line-numbered errors; 20,000-row cap; formula escaping. Fuzz: 200 random certificates round-trip, 500 random strings never decode half-valid, 300 random tables survive `toCsv` → `parseCsv` |
| End to end | **Playwright (Chromium)** against a real Hardhat **JSON-RPC node** (9 tests) | Upload CSV → backup → publish (one tx, double click) → pack → scan the QR **image** → every link Valid → forged grade Not found → revoke from the portal → Revoked; rebuild a lost pack; wrong network + switch; non-institution key; suspended institution; rejected tx; bad CSV; Distrusted; XSS; look-alike-site warning; junk QR; RPC outage; server headers, Host check, read-only, path traversal |
| Deploy kit | dry run on `npx hardhat node` | `deploy:local` → `deployments/localhost.json` + `config.json`; `council` add-issuer (120,009 gas), duplicate key refused before sending, suspend |
| Test of the tests | `npm run planted-bugs` | 36 bugs planted one at a time (22 from Day 28 + **14 in the web app**); the suite must fail for each |
| Tooling | npm audit · solhint · Slither | Dependencies, lint, static analysis |

## Findings (found and fixed during QA)

Each was found after the first green run, proven with a failing test, then fixed.

| ID | Severity | Found by | Description | Fix | Proving test |
|---|---|---|---|---|---|
| F-5 | **High** | Manual review (attacker view) | **A rogue college could make the checker say "Valid — issued by National Examinations Board".** The contract binds each leaf to the *batch's* institution, but the page showed the name for the institution id written **in the QR**. A registered (or hacked) small college could publish its own batch with NEB's id inside the QR and the hash; the contract said Valid (for the college) and the page printed NEB's name. | The page reads the batch's owner **from the chain** (`batches(id).issuerId`). If the QR claims anyone else, the answer is **Not found**; the name shown is always the on-chain owner's. | `F-5: a rogue college can't make the checker say a certificate is from NEB` (failed before the fix: `expected 'VALID' to equal 'NOT FOUND'`); planted "verifier trusts the institution id in the QR" caught |
| F-6 | Low | Screenshot review | **Hidden controls were visible.** The CSS `display` rules for `.row` and `button` overrode the `hidden` attribute, so **"Switch network" showed on the right chain** and an **empty "local test wallet" picker showed in production**, inviting clicks that do nothing or confuse staff. | `[hidden] { display: none !important; }` | `F-6: hidden controls stay hidden` (failed before the fix: `expected true to equal false`) |

The planted-bug run also found a **weak test**: "rebuild a lost pack" only tried another institution's batch, so the root check could be removed and the issuer check alone still passed. The test now also tries a different batch of the **same** institution (root mismatch). One functional bug was caught by the first end-to-end run: the CSV preview rows were added to the table header (fixed with an explicit `<tbody>`).

No high or medium findings are left open.

## Built-in defences (each has a test; the planted bug shows the test can fail)

| ID | Attack | Defence | Planted bug caught |
|---|---|---|---|
| D-15 | **Hostile text in a QR** (`<img onerror=…>` as a name) | Every value is set with `textContent`; strict CSP (`script-src 'self'`) | verifier writes QR text as HTML |
| D-16 | **Forged details shown next to "Not found"** | A fake's claimed name/grade is never displayed | forged certificate's claimed details are shown |
| D-17 | **Look-alike checker site** in the QR | The real page warns when a scanned QR points to another host, and answers from the real chain anyway | no warning for a QR that points to another website |
| D-18 | **Outage read as "fake"** | RPC errors show "Could not check", never "Not found"; the RPC's chain id and contract code are checked first | RPC outage reported as a fake certificate |
| D-19 | **Lost salts** (QR codes can never be made again) | Publish stays disabled until the backup (all salts) is downloaded | publish allowed before the salts are backed up |
| D-20 | **Double-sent batch** (impatient double click) | One in-flight transaction; the same prepared file can't be published twice | double click publishes twice |
| D-21 | **Rebuilt pack for the wrong batch** | Root, owner and count are compared with the chain before any link is made | rebuilt pack not checked against the chain |
| D-22 | **Wrong network** | Chain id checked on connect; publish disabled; one-click switch | wrong network not detected |
| D-23 | **Two students, one number** | CSV refused with line numbers (case-insensitive) | duplicate certificate numbers allowed in the CSV |
| D-24 | **CSV injection** (a "name" like `=HYPERLINK(…)` in the pack opened in Excel) | Cells starting with `= + - @ tab CR` get a leading apostrophe | spreadsheet formulas left live in the pack |
| D-25 | **Malformed QR payload** | Strict decoder: version, integer ids, 6 non-empty fields ≤ 200 chars, 32-byte salt, ≤ 32 proof hashes, ≤ 4,000 chars | salt of any length accepted from a QR |
| D-26 | **DNS rebinding / file leaks** on the local server | Host must be `127.0.0.1`/`localhost`; GET/HEAD only; files only from `public/` | server answers any Host · serves files outside public/ |
| D-27 | **Personal data leaking** | Hashing happens in the browser; only the root and count are sent. The certificate rides in the link's `#fragment`, which browsers never send to servers. The test checks every request: no name, no salt; the server never saw a `#`, a name or a certificate number | (asserted in the main end-to-end test) |
| D-28 | **Mistaken council or deploy action** | `council.js` simulates first (fails with the reason before gas), prints Safe calldata if the signer isn't the council; `deploy.js` warns when the council is not a multisig; no key ever printed; `.env` git-ignored | (dry-run on a local node) |

## Known issues (accepted, with reasoning)

| ID | Issue | Why accepted / plan |
|---|---|---|
| K-6 | **Big QR codes for big batches.** A 10,000-certificate batch needs a 14-hash proof: links of 1,000–1,123 characters, QR **version 27** (6-certificate sample: 387 characters, version 15). | Scannable when printed at 4 cm or more. A shorter "v2" link that fetches the proof from a static batch file is a Day 30 audit item. |
| K-7 | **The verifier trusts its site and its RPC.** A fake site or a lying RPC can answer anything. | Official domain printed on the paper, look-alike-site warning, CSP, chain-id and contract checks. Production: institutions run their own nodes (DESIGN.md). |
| K-2 (Day 28) | **The same number in two batches.** | The portal refuses duplicates inside a file, but it can't see inside earlier batches (only their roots are on-chain), so the Day 28 plan "check earlier batches" is not possible in the browser. Institutions can check against their own earlier backups; revisited in the Day 30 audit. |
| K-8 | **The backup file holds every salt and all personal data.** | Needed to rebuild lost QR codes. The portal says to keep it offline; DEPLOY.md's checklist repeats it. |
| K-9 | **Scanning uses a photo** (the phone camera through the file picker), not a live video stream. | Works on every phone browser without camera permissions; a live scanner is a later nicety. |
| K-10 | **About 1 MB of JavaScript per page** (viem + ethers + QR code libraries). | Loads once; acceptable for a capstone. Moving the hashing library from ethers to viem would roughly halve it. |

## Static analysis and dependencies

- `npm audit --omit=dev`: **0 vulnerabilities** (viem is the only runtime dependency).
- `solhint`: **0 problems**.
- `slither`: **0 results** (contract unchanged).

## Final green output

```
  Pramaan — council / single certificates / batches / stolen issuer key / QA findings     30 passing
  Fuzz — batches · stolen key timelines                                                    2 passing
  lib/pramaan.js                                                                            6 passing
  Day 29 — QR payload                                                                       5 passing
  Day 29 — results CSV                                                                      6 passing
  Day 29 — the web app end to end (Chromium + JSON-RPC node)                                9 passing
      Published: batch #1, 6 certificates in one transaction (95,790 gas).

  58 passing (15s)

npm run planted-bugs
 1–22  CAUGHT  (Day 28 contract and hashing library bugs, unchanged)
23. CAUGHT  verifier trusts the institution id in the QR (F-5)
24. CAUGHT  verifier writes QR text as HTML (XSS)
25. CAUGHT  forged certificate's claimed details are shown
26. CAUGHT  RPC outage reported as a fake certificate
27. CAUGHT  no warning for a QR that points to another website
28. CAUGHT  publish allowed before the salts are backed up
29. CAUGHT  double click publishes twice
30. CAUGHT  rebuilt pack not checked against the chain     (missed at first: weak test, see above)
31. CAUGHT  wrong network not detected
32. CAUGHT  duplicate certificate numbers allowed in the CSV
33. CAUGHT  spreadsheet formulas left live in the pack (CSV injection)
34. CAUGHT  salt of any length accepted from a QR
35. CAUGHT  server answers any Host (DNS rebinding)
36. CAUGHT  server serves files outside public/ (path traversal)

36 of 36 planted bugs caught

npm audit --omit=dev   found 0 vulnerabilities
solhint                0 problems
slither                . analyzed (5 contracts with 101 detectors), 0 result(s) found
```
