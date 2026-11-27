# Day 28 — Capstone, part 1: Pramaan (प्रमाण)

## What I built

The design and smart contract for **Pramaan** ("proof"), a dApp against **fake academic certificates in Nepal**. Boards and universities publish a fingerprint (hash) of every certificate, even a whole exam result of 10,000 students in one transaction. An employer, a manpower agency or an embassy anywhere can then check a certificate in seconds, for free, without calling the institution, and no personal data goes on the blockchain.

The code lives in [`capstone/`](../capstone) (it grows on Days 29 and 30). The full design is in **[capstone/DESIGN.md](../capstone/DESIGN.md)**.

## How it works

Think of a seal. Today the seal is ink and a forger can copy it. With Pramaan, the board keeps a public list of fingerprints of every real certificate it issued. Change one letter on the paper and its fingerprint no longer matches anything on the list.

1. **Publishing.** The institution hashes the printed fields plus a random secret (the *salt*, printed only in the QR code) into a `docHash`. It publishes it on its own (`issue`, 73,873 gas) or as part of a batch: thousands of hashes become one Merkle root (`issueBatch`, Day 10's trick: 95,802 gas for 10,000 results, **9.6 gas per certificate**).
2. **Checking.** The verifier scans the QR, recomputes the hash from the paper and asks the contract. Reading costs nothing. The answer is **Valid**, **Unknown** (never issued, or the paper was changed), **Revoked** (withdrawn, with a reason) or **Distrusted** (made with a stolen key).
3. **Stolen keys.** If an institution's key is stolen, the council (a 2-of-3 multisig) reports *when* it may have started. Everything the key did from then until the report is no longer trusted: the thief's fake certificates become Distrusted, the thief's revocations of real certificates are ignored, and the key is replaced and can never come back.

```
 Institution                      Pramaan contract                         Verifier
 fields + salt → docHash
 issue(serial, docHash)   ────▶   records[issuer, serial]
 issueBatch(root, 10,000) ────▶   batches[id]
 QR: issuer · serial · salt (· batch · proof)                              scan QR + read paper
                                  verify / verifyInBatch ◀──────────────── (free, read-only)
                                  → Valid | Unknown | Revoked | Distrusted

 Council (2-of-3): addIssuer · setIssuerActive · rotateKey · reportCompromise(since, newKey)
                   (it can NOT issue or revoke certificates)
```

Who uses it, what goes on-chain and why, the chain choice (no token, no payments) and the security design: [DESIGN.md](../capstone/DESIGN.md).

## Run it yourself

```bash
cd capstone
npm install
npm test               # 38 tests: 30 contract, 6 lib, 2 fuzz properties (about 5 s)
npm run demo           # 10,000-result batch, checks, a revocation and a stolen key
npm run planted-bugs   # plants 22 security bugs one at a time: the tests must catch all 22 (~2 min)
npm run lint           # solhint
npx hardhat compile && npm run slither
```

## Results from my run

```
Tests                     38 passing (4 s): 30 contract, 6 lib, 2 fuzz
Demo (npm run demo)
  institutions            3 registered (gas to add one: 120,009)
  NEB exam batch          10,000 certificates in ONE transaction: 95,802 gas → 9.6 gas per certificate
                          proofs are 8–14 hashes; a check costs about 41,000–46,000 gas of free read-only work (3 runs)
  one TU degree           73,873 gas
  checks                  real result → Valid · real degree → Valid · grade changed → Unknown
                          made-up degree → Unknown · NEB results re-published by KU → Unknown
  fraud found             TU revokes the degree (51,425 gas) → Revoked (fraud)
  stolen NEB key          thief sells a fake (Valid) and "revokes" a real result (Revoked)
                          council reports 3 days later (126,429 gas):
                          fake → Distrusted · real result → Valid again · stolen key refused · new key → Valid
Fuzz                      60 random batches (1–120 certificates): 180 checks, 0 wrong
                          40 random stolen-key timelines: 188 records checked against who really made them
Planted bugs              22 of 22 caught (18 contract, 4 hashing library)
npm audit --omit=dev      0 vulnerabilities
Solhint                   0 problems
Slither                   0 results
```

## What I learned

- **Designing for the bad day is most of the work.** Issuing and checking took an hour of thinking; deciding what happens when a university's key is stolen took the rest: which records to distrust, how to stop the thief cancelling real degrees, how to let the university re-use a serial the thief "squatted", and how to stop the new key landing inside the window.
- **A hash is only private if it can't be guessed.** A name, a birthday and a grade can be brute-forced from a bare hash in seconds; the random salt in the QR code is what keeps the chain free of personal data.
- **Tests need testing too.** My "moving text between fields" test passed even with the bug planted, because the two fields I chose aren't next to each other in the hash. The planted-bug run found the weak test.

## Security notes

4 findings fixed (1 medium, 3 low), 22 planted bugs caught, and known limits (a public certificate number, a trusted council, duplicate serials across batches) written down. Details and full output: [QA.md](QA.md).

## References

- [Republica — Probe finds government staff with fake certificates](https://myrepublica.nagariknetwork.com/news/probe-finds-govt-staff-with-fake-certificates)
- [The Himalayan Times — CIAA: institute a scrutiny system to curb fake credentials](https://thehimalayantimes.com/nepal/institute-scrutiny-system-to-curb-fake-credentials-ciaa)
- [UNESCO IIEP ETICO — Nepal cracks down on fake degrees](https://etico.iiep.unesco.org/en/nepal-cracks-down-fake-degrees)
- [OpenZeppelin Contracts — MerkleProof](https://docs.openzeppelin.com/contracts/5.x/api/utils#MerkleProof)
- [W3C — Verifiable Credentials Data Model 2.0](https://www.w3.org/TR/vc-data-model-2.0/)

## Next

Day 29 — **Capstone, part 2:** the Pramaan web app (an institution portal that publishes a CSV of results, and a verifier page that scans the QR code), end-to-end tests and a deploy kit.
