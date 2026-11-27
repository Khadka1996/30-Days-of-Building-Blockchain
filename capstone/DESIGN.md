# Pramaan (प्रमाण) — design

**Pramaan** means "proof". It lets anyone check, in seconds and for free, that a Nepali academic certificate is real, unchanged and not withdrawn, without phoning or visiting the board or university that issued it.

## 1. The problem

Fake academic certificates are a recurring problem in Nepal:

- Government probes keep finding **public servants hired or promoted with fake certificates**, and the anti-corruption commission (CIAA) has asked institutions to build a system that checks credentials ([Republica](https://myrepublica.nagariknetwork.com/news/probe-finds-govt-staff-with-fake-certificates), [The Himalayan Times](https://thehimalayantimes.com/nepal/institute-scrutiny-system-to-curb-fake-credentials-ciaa), [UNESCO ETICO](https://etico.iiep.unesco.org/en/nepal-cracks-down-fake-degrees)).
- **Foreign employment and study abroad** run on documents. Employers, agencies and embassies abroad can't easily check a paper from a board in Sanothimi or a campus in Pokhara, so forged papers get used for jobs and visas ([Onlinekhabar](https://english.onlinekhabar.com/fake-documents-israeli-jobs-nepal.html), [Kathmandu Post](https://kathmandupost.com/national/2026/06/11/fake-documents-used-to-secure-student-visas-for-ten-foreigners-in-nepal)).

Today a check means a letter, a visit or an email to the institution, and it can take days. A forger only needs a good printer.

## 2. Who uses it

| Who | What they do | Key they hold |
|---|---|---|
| **Council** (e.g. Ministry of Education + University Grants Commission + one board, as a 2-of-3 multisig like Day 4) | Registers institutions, suspends them, replaces a stolen key | Council multisig |
| **Institution** (NEB, Tribhuvan University, Kathmandu University, …) | Publishes certificates (one at a time or a whole exam result), revokes them | One institution key |
| **Graduate** | Gets a paper certificate with a QR code | None, no wallet needed |
| **Verifier** (employer, manpower agency, embassy, foreign university, Public Service Commission) | Scans the QR, reads the answer | None, reading is free |

## 3. What goes on-chain, and why

| On-chain | Why |
|---|---|
| `serial` = keccak256(certificate number) | One record per certificate number per institution, so a forger can't publish a second "real" version |
| `docHash` = keccak256(issuer id, every printed field, a random 32-byte **salt**) | Any change to the paper (name, grade, date) changes the hash. The salt (only in the QR code) stops anyone guessing a student's details from the public hash |
| Merkle **root** per batch | A board can publish 10,000 results in **one transaction** (95,802 gas, **9.6 gas per certificate**) |
| Revocations with a reason code | Withdrawn certificates show as Revoked, everywhere, at once |
| Institutions, keys and **compromise windows** | Everyone can see who may issue, and which records a stolen key made |

**Not on-chain:** names, dates of birth, grades, photos, any personal data. The chain stores only hashes; the paper and its QR code carry the details. Deleting personal data later (the "right to be forgotten") is then simple: the hash alone reveals nothing.

**Why a blockchain and not one database?** No single office has to be trusted or kept online: a verifier in Qatar reads the same answer as one in Kathmandu, an insider can't quietly edit an old record, and every issue and revocation is timestamped and public. A shared database would need every institution and every verifier to trust and reach the one office that runs it.

**Which chain?** Nepal Rastra Bank treats cryptocurrency transactions as illegal, so Pramaan has **no token and no payments**. The contract runs on any EVM chain; the intended setup is a **permissioned EVM network run by the council and institutions** (each runs a node), or an L2 where the institutions pay the gas. Verifiers only read, which costs nothing. Day 30 shows a test-network deployment for the demo.

## 4. How it works

```
 Institution (off-chain)                         Pramaan contract                    Verifier
 ───────────────────────                         ────────────────                    ────────
 certificate fields + random salt
   → docHash = H(issuerId, fields, salt)
 1 certificate:    issue(serial, docHash)  ───▶  records[H(issuerId, serial)]
 10,000 results:   issueBatch(root, n)     ───▶  batches[id]
 QR on the paper: issuerId · serial · salt
                  (· batchId · proof)                                                scan QR + read paper
                                                                                     → docHash again
                                            ◀──  verify / verifyInBatch  ◀────────── (free, read-only)
                                                 → Valid | Revoked | Distrusted | Unknown
```

**Statuses**
- **Valid:** published by that institution, unchanged, not withdrawn.
- **Unknown:** never published, or the paper was changed (its hash doesn't match). Treat as fake.
- **Revoked:** withdrawn by the institution (1 = fraud, 2 = error and re-issued with a new number, 3 = withdrawn).
- **Distrusted:** published with a key that was stolen at the time. The institution can re-issue it with its new key.

## 5. Security design

| Risk | Design |
|---|---|
| Forged or edited paper | The verifier recomputes `docHash` from the paper; any change → Unknown |
| Fake "university" | Only the council registers institutions; the app shows the registered name |
| One institution writing another's records | Records are keyed by (issuer id, serial); the issuer id is in the batch leaf and in `docHash` (F-1) |
| **Stolen institution key** | The council reports a **compromise window** (`since` → the report block): records the key made in it become Distrusted, its revocations are ignored, serials it squatted can be re-issued, and the key is replaced and retired for ever. The new key starts one block later, so nothing it does falls inside the window |
| Malicious or careless council | 2-of-3 multisig; it **can't issue or revoke** certificates; `since` can reach back at most 180 days; it can't renounce (F-3); every action is a public event |
| Guessing personal data from hashes | 32-byte random salt per certificate, kept only in the QR code |
| Merkle tricks | Double-hashed leaves (Day 10), so an inner node can't pass as a certificate |
| Same name typed two ways (Devanagari) | Unicode NFC + space cleanup before hashing |

Known limits are listed in [`day-28/QA.md`](../day-28/QA.md).

## 6. Code

- [`contracts/Pramaan.sol`](contracts/Pramaan.sol): the registry (council, institutions, single and batch issue, revoke, verify, compromise windows).
- [`lib/pramaan.js`](lib/pramaan.js): how an institution makes `serial`, `docHash` and a batch tree (ethers only).
- [`test/`](test/): 38 tests: contract, lib, fuzz.
- [`scripts/demo.js`](scripts/demo.js): the full story on a local chain. [`scripts/planted-bugs.py`](scripts/planted-bugs.py): 22 planted bugs the tests must catch.

## 7. Next

- **Day 29:** the web app (an institution portal to publish a CSV of results and a verifier page that scans the QR code), end-to-end browser tests and a deploy kit.
- **Day 30:** a full self-audit report (`AUDIT.md`), a live test-network demo and the 30-day wrap-up.
