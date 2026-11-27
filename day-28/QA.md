# Day 28 — QA and security review (Pramaan contracts)

**Scope:** [`capstone/contracts/Pramaan.sol`](../capstone/contracts/Pramaan.sol) and the hashing library [`capstone/lib/pramaan.js`](../capstone/lib/pramaan.js). The full self-audit report comes on Day 30.

**Security focus (capstone):** everything learned in Days 1–27, aimed at what would really hurt a certificate registry:
- can someone **make a fake certificate read Valid**: edit a real one, invent one, copy another institution's records, or trick the Merkle proof?
- what happens when an **institution's key is stolen**: can the thief's fakes stay valid, can the thief cancel real degrees, can the thief block the real serials?
- can the **council** (the admin) abuse its power or lock the system?
- does the chain leak **personal data**?

## How it was tested

| Layer | Tool | What it covers |
|---|---|---|
| Contract | Hardhat + chai (30 tests) | Council-only admin, roles kept apart, two-step handover; issue/verify, edited paper and wrong salt → Unknown, one record per serial, per-institution namespaces; revoke (once, with reason); suspension; routine key rotation; batches: every proof, tampered/foreign/inner-node proofs, single and whole-batch revocation; stolen key: fakes Distrusted, thief's revocations ignored (single and batch), squatted serials re-issued, same-block ordering, 180-day lookback, window limit |
| Library | mocha (6 tests) | Unicode NFC (Devanagari typed two ways), field boundaries, issuer/salt/every field in the hash, bad input, serial normalisation, duplicate serials in a batch |
| Fuzz | fast-check (2 properties) | 60 random batches of 1–120 certificates → members Valid, tampered and outsiders Unknown (180 checks). 40 random stolen-key timelines (random issues and revocations before and during the theft, random `since` up to 20 days early) → the thief's records are never Valid, the thief's revocations never count, real work before the theft is exactly as the institution left it, nothing real becomes Unknown, Distrusted records can be re-issued (188 records) |
| Test of the tests | `npm run planted-bugs` | 22 bugs planted one at a time (18 contract, 4 library); the suite must fail for each |
| Tooling | npm audit · solhint · Slither | Dependencies, lint, static analysis |

## Findings (found and fixed during QA)

Each was found after the first green run, proven with a failing test, then fixed.

| ID | Severity | Found by | Description | Fix | Proving test |
|---|---|---|---|---|---|
| F-2 | **Medium** | Manual review (attacker view) | **A 6th stolen key could not be reported.** To keep `verify` cheap, compromise windows were capped at 5 per institution, and the 6th `reportCompromise` reverted. A thief holding that key could then sell fakes that stayed Valid for ever; the council could only suspend the institution. | Never refuse a report: at the cap, the last window is **stretched** to cover the new one (earliest `since`, latest block). It may distrust some real records in between, which the institution can re-issue: the safe direction. | `F-2: a 6th stolen key can still be reported` (failed before the fix: `TooManyCompromises()`); planted "too many reports refused" caught |
| F-1 | Low | Manual review (attacker view) | **Another institution could re-publish NEB's batch as its own.** The Merkle leaf was `(serial, docHash)`, so a registered (or compromised) college could publish NEB's root under its own id and NEB's students would show as "Valid at that college". | The issuer id is inside the leaf (`abi.encode(issuerId, serial, docHash)`) and inside `docHash`, so a copy never matches. | `F-1: another institution can't re-publish NEB's batch` (failed before the fix: `expected 1 to equal 0`, i.e. Valid instead of Unknown); planted "issuer id not in the leaf" caught; demo step 4 |
| F-3 | Low | Manual review | **The council could renounce ownership** (inherited from `Ownable`). After that nobody could suspend an institution or report a stolen key again. | `renounceOwnership` always reverts (`RenounceDisabled`); handing over the council stays possible in two steps. | `F-3` (failed before the fix: the contract had no `RenounceDisabled` guard); planted "council may renounce" caught |
| F-4 | Low | Manual review | **A retired stolen key could come back.** After a rotation the old key was simply forgotten, so a copy-paste mistake by the council could register the thief's key again (as the same or a new institution). | Replaced keys are stored in `retiredKey` and refused for ever. | `F-4` (failed before the fix: `rotateKey` to the old key did not revert); planted "retired keys may come back" caught |

The planted-bug run also found a **weak test**: "moving text between fields changes the hash" passed even with plain concatenation planted, because the two fields chosen were not next to each other in the hash. The test now uses two adjacent fields (`program` "MBBS" + `result` "Pass" vs "MBB" + "SPass").

No high or medium findings are left open.

## Built-in defences (each has a test; the planted bug shows the test can fail)

| ID | Attack | Defence | Planted bug caught |
|---|---|---|---|
| D-01 | **Edited paper** (grade, name, date) | `verify` compares the recomputed `docHash` | verify ignores the document hash |
| D-02 | **Fake institution** | Only the council registers institutions | anyone can register |
| D-03 | **Overwrite a real record** | One record per (institution, serial) | serial can be overwritten |
| D-04 | **Write into another institution's records** | Records keyed by issuer id; batches revocable only by their owner | no namespace · anyone's batch can be revoked |
| D-05 | **Merkle second preimage** | Double-hashed leaves | single leaf hash |
| D-06 | **Thief's fakes stay valid** | Compromise window from `since` to the report block | window ignores the start time |
| D-07 | **Thief cancels real degrees** | Revocations inside a window are ignored | thief's revocations still count |
| D-08 | **Thief keeps acting / new key inside the window** | Old key removed; new key starts next block | old key not removed · new key in the report block |
| D-09 | **Council over-reach** | Can't issue or revoke; `since` at most 180 days back | anyone can report · no lookback limit |
| D-10 | **Suspended institution keeps issuing** | `IssuerSuspended` | suspended can still issue |
| D-11 | **Withdrawn batch still valid** | `verifyInBatch` checks batch revocation | batch revocation ignored |
| D-12 | **Guessing personal data** | 32-byte random salt in every `docHash` | salt left out |
| D-13 | **Same name, two encodings / field shifting** | Unicode NFC + `abi.encode` with fixed field order | no normalisation · concatenation |
| D-14 | **Two documents for one serial in a batch** | The library refuses duplicate serials | duplicates allowed |

Also checked: zero serial, hash, root, count or reason; unknown institution ids; council key used as an issuer key; two-step council handover; same-block ordering of thief, report and new key; suspension keeps old certificates valid; no external calls in the contract (no re-entrancy surface).

## Known issues (accepted, with reasoning)

| ID | Issue | Why accepted / plan |
|---|---|---|
| K-1 | **Certificate numbers are public and guessable** (`serial` = hash of e.g. `SEE-2081-004211`), so anyone can see that number 004211 exists, when it was published and whether it was revoked (and the reason code). Names and grades stay private. | Hiding it would need the salt in the serial, which breaks "one record per certificate number". Day 29's app shows only the status, and reason codes are kept coarse. |
| K-2 | **The same serial can appear in two batches** (or a batch and a single record), so two versions could both read Valid. | The contract can't see inside a batch. The library refuses duplicates within a batch, revoking a serial revokes every copy, and corrections must use a new number (reason 2). The Day 29 portal will check earlier batches before publishing. |
| K-3 | **The council is trusted** to report the right `since`. A wrong (too early) `since` makes real records Distrusted. | Limited: a 2-of-3 multisig, it can't issue or revoke, 180-day cap, every action is a public event, and Distrusted records can be re-issued. A timelock (Day 14/27) can be added on Day 30 if the audit asks for it. |
| K-4 | **Over-distrust after a routine rotation:** if a key is rotated after a theft started but before it is reported, the new key's records inside the window are also Distrusted. | Safe direction; they can be re-issued. The council should report a theft before (or instead of) a routine rotation. |
| K-5 | **Block time** decides which records fall in a window. Validators can shift timestamps by seconds. | On the intended permissioned chain the validators are the institutions; seconds don't matter for a window of days. |

## Static analysis and dependencies

- `npm audit --omit=dev`: **0 vulnerabilities** (no runtime dependencies yet).
- `solhint`: **0 problems**.
- `slither`: **0 results**. One `uninitialized-state` warning on `_compromises` was a false positive (it is written through a storage pointer, `ws.push`, which Slither does not follow) and is silenced inline with that reason.

## Final green output

```
  Pramaan — council                                  6 passing
  Pramaan — single certificates                      7 passing
  Pramaan — batches                                  5 passing
  Pramaan — stolen issuer key                        8 passing
  Pramaan — QA findings (F-1 … F-4)                  4 passing
  Fuzz — batches                  180 batch checks, 0 wrong
  Fuzz — stolen key timelines     188 records checked against who really made them
  lib/pramaan.js                                     6 passing

  38 passing (4s)

npm run planted-bugs
 1. CAUGHT  anyone can register an institution
 2. CAUGHT  anyone can report a compromise
 3. CAUGHT  a suspended institution can still issue
 4. CAUGHT  a serial can be overwritten (forger replaces a real record)
 5. CAUGHT  verify ignores the document hash
 6. CAUGHT  single leaf hash (inner node passes as a certificate)
 7. CAUGHT  issuer id not in the leaf (F-1: copied batches)
 8. CAUGHT  one institution's serials shared by all (no namespace)
 9. CAUGHT  anyone's batch can be revoked
10. CAUGHT  batch revocation ignored by verify
11. CAUGHT  thief's revocations still count
12. CAUGHT  compromise window ignores the start time
13. CAUGHT  new key may act in the report block
14. CAUGHT  old key not removed on rotation
15. CAUGHT  no lookback limit for the council
16. CAUGHT  too many reports refused (F-2)
17. CAUGHT  council may renounce (F-3)
18. CAUGHT  retired keys may come back (F-4)
19. CAUGHT  salt left out of the document hash
20. CAUGHT  no Unicode normalisation
21. CAUGHT  fields concatenated instead of abi.encode
22. CAUGHT  duplicate serials allowed in a batch

22 of 22 planted bugs caught

npm audit --omit=dev   found 0 vulnerabilities
solhint                0 problems
slither                . analyzed (10 contracts with 101 detectors), 0 result(s) found
```
