# Day 07 — QA and security review

**Code:** `lib/deployKit.js`, `scripts/*.js`, `hardhat.config.js`, plus the six Week 1 contracts in `contracts/` (byte-identical copies of Days 01–06) · **Security focus:** review of the whole week, and keeping deploy secrets safe

## How it was checked

1. Unit tests for every safety rule of the deploy kit (`npx hardhat test`): network allowlist, private-key format, half-configured `.env`, multisig settings, gas budget, resume after a failed run, stale records, verification arguments, post-deploy check
2. A fuzz test with **fast-check**: 40 random owner lists (duplicates, the zero address, 0–12 owners) and thresholds (0–12). For each one, the JavaScript check must agree with the real `MultiSigWallet` constructor on-chain: accept exactly what the contract accepts, reject exactly what it rejects
3. A week tour: deploy all six contracts with the kit, then use each one for its main job (add a task, lock and withdraw, vote, a 2-of-3 payment, an escrow deal, a successful campaign)
4. Secret hygiene tests: `.env` is git-ignored, `.env.example` is blank, and no file in the folder contains a private key
5. `npm audit --omit=dev`, `solhint` (recommended rules), `slither` on all seven Week 1 source files together
6. Manual review like an attacker: what can go wrong between "it works on my laptop" and "it is live on Sepolia"? Wrong network, leaked keys, wrong owners, running out of ETH half-way, paying twice after a crash, verifying with the wrong arguments

## Findings

D-01 to D-08 came from the attacker review of the deploy kit before the first build (each threat is written as a test that would fail on a naive script). D-09 came from round 2 of the review after the first green run. W-01 to W-04 come from the week-wide review of the six contracts.

| ID | Severity | Found by | Description | Fix | Proving test |
|----|----------|----------|-------------|-----|--------------|
| D-01 | High | Design review | **Wrong network.** A typo in `--network` or an RPC URL that points to Ethereum mainnet would deploy with whatever money the key holds. | Two layers: `assertSafeNetwork` refuses every chain except Sepolia (11155111) and local Hardhat (31337), and the Sepolia network in `hardhat.config.js` pins `chainId: 11155111`, so Hardhat itself stops if the RPC answers with another chain. | `allows only the local chain and Sepolia, refuses mainnet and others` |
| D-02 | High | Design review | **Private key in git.** The most common real-world loss: a key pasted into a config file and pushed to a public repo, where bots sweep it within minutes. | The key is only read from `.env`, which the root `.gitignore` ignores; `.env.example` ships with an empty `PRIVATE_KEY=`; a test scans every file in the folder for anything that looks like a key. | `.env is ignored by git and .env.example holds no key`, `no file in day-07 tracked by git contains something that looks like a private key` |
| D-03 | Medium | Design review | **Malformed key.** A key with a missing `0x`, a stray character or a placeholder fails deep inside ethers with an error that can echo part of the key. | `assertPrivateKeyFormat` runs when Hardhat loads the config: exactly `0x` + 64 hex, not all zeros. The error message never contains the key. | `accepts a 0x + 64 hex private key and rejects anything else without printing it`, `hardhat.config refuses to load with a malformed PRIVATE_KEY` |
| D-04 | Medium | Design review | **Wrong multisig settings paid for on-chain.** A duplicate owner or a threshold of 4-of-3 only fails after paying gas. Worse, a lazy default of "the deployer is the only owner" would quietly give one key control of the wallet. | `validateMultisig` checks owners and threshold with the same rules as the constructor before any transaction. On Sepolia, `MULTISIG_OWNERS` must be set on purpose (no default). | `a bad setting stops the run with zero transactions sent`, fuzz test (JS check = constructor, 40 runs), `the multisig is owned by the chosen owners, not by the deployer` |
| D-05 | Medium | Design review | **Running out of ETH half-way.** Three contracts deployed, three missing, and faucet ETH gone. | Every remaining deploy is estimated first; if `balance < gas × maxFeePerGas`, the run stops with "Nothing was sent". | `refuses to start when the wallet cannot pay for the whole run, sending nothing` |
| D-06 | Medium | Design review | **Paying twice after a crash.** Re-running a deploy script after a network error normally deploys everything again. | The record file is saved after **each** contract; a re-run skips contracts that are in the record **and** have code on-chain. | `a second run resumes…`, `a run that stopped half-way deploys only the missing contracts` |
| D-07 | Medium | Design review | **Trusting a stale record.** A record from an old chain (or a hand-edited file) points at an address with no contract, or the settings changed since the first run, mixing two setups. | A saved address is reused only if `getCode` is not empty; a contract saved with different constructor arguments stops the run with a clear message. | `an address in the record with no code (a fresh chain) is deployed again, not trusted`, `refuses to resume with different multisig settings…` |
| D-08 | Low | Design review | **Verification with the wrong arguments.** Etherscan verification fails (or is skipped) when constructor arguments are retyped by hand. | Arguments are stored in the record and reused by `verify.js`; the multisig's array argument is written to an args file for the CLI command. `check.js` compares the multisig's on-chain owners and threshold with the record. | `builds one Etherscan job per contract…`, `the check passes on a good deploy and catches missing code and wrong multisig settings` |
| D-09 | Low | Review round 2 | **Half a Sepolia setup.** With only `SEPOLIA_RPC_URL` or only `PRIVATE_KEY` in `.env`, Hardhat silently left the Sepolia network out and later failed with a vague "network not found". | `hardhat.config.js` now stops with "Set BOTH SEPOLIA_RPC_URL and PRIVATE_KEY". | `hardhat.config refuses half a Sepolia setup…` |
| W-01 | Low | Week review | **Copies drifting.** Day 07 deploys copies of the six contracts; a later edit to one copy would deploy code that was never reviewed. | A test compares every file byte for byte with its Day 01–06 original. | `deploys exactly the reviewed code…` |
| W-02 | Info | slither (`low-level-calls`) | `PiggyBank.withdraw()` sends ETH with `call`. Days 04–06 mark the same pattern with a `slither-disable` comment; Day 02 does not. | Accepted: the result is checked and the balance is deleted before sending (checks → effects → interaction). The file is kept unchanged so it stays identical to Day 02 (W-01). | Day 02 reentrancy tests |
| W-03 | Info | Week review | `PiggyBank` stores balances as `uint128` and casts `msg.value` down. | Accepted: `uint128` holds about 3.4 × 10^38 wei, far more than all ETH that exists (about 1.2 × 10^26 wei), so the cast cannot cut a real deposit. | — |
| W-04 | Info | slither (`timestamp`) | Deadlines in Days 02, 03, 05 and 06 compare `block.timestamp`. | Accepted: validators can shift time by seconds, and every deadline is minutes to years long. Excluded in `slither.config.json`. | — |

No high or medium issues remain open.

## Week 1 in one table

| Day | Contract | Main risk handled | How |
|----:|----------|-------------------|-----|
| 01 | TodoList | Someone else editing your list | Each list lives under `msg.sender`; no admin |
| 02 | PiggyBank | Withdrawing twice / early | Checks → effects → interaction; unlock date can only move later |
| 03 | Voting | Double voting, late votes | `hasVoted` per poll, strict deadline |
| 04 | MultiSigWallet | Replay, double approval, removed owners | Executed flag, one approval per owner, config version makes old proposals stale |
| 05 | Escrow | Stuck funds, wrong person releasing | One-way state machine, arbiter timeouts, pull payments |
| 06 | CrowdFund | Refund loops, claiming twice | Pull refunds, effects before transfer, per-campaign counters |

The same three habits run through all six: **write state before sending ETH**, **let people pull their own money**, and **check who is calling every function that moves money**.

## Known issues (by design, documented)

| ID | Description | Why it is accepted today |
|----|-------------|--------------------------|
| K-01 | The kit cannot tell a test-only key from a key that also holds real money on mainnet. | It never connects to mainnet (D-01), but the key is still a key. `DEPLOY.md` says to create a brand-new wallet for testing only. |
| K-02 | The gas budget uses today's `maxFeePerGas`; if fees jump during the run, a later deploy can still run out. | `maxFeePerGas` is already about 2× the base fee, and the resume (D-06) finishes the run after a top-up without paying twice. |
| K-03 | The actual Sepolia deployment and Etherscan verification are not run here (public networks are blocked in the build environment). | Every step is rehearsed on the local chain (`npm run demo`); Manish runs the real deployment from his laptop with `DEPLOY.md`. |

## Final green run

```

  Day 07 — Week 1 deploy kit
    network and key checks
      ✔ allows only the local chain and Sepolia, refuses mainnet and others
      ✔ accepts a 0x + 64 hex private key and rejects anything else without printing it (48ms)
      ✔ hardhat.config refuses to load with a malformed PRIVATE_KEY (349ms)
      ✔ hardhat.config refuses half a Sepolia setup (RPC URL without key, or key without URL) (697ms)
    multisig settings are checked before any gas is spent
      ✔ parses a comma list into checksummed addresses and rejects junk
      ✔ rejects empty, too many, zero, duplicate (any letter case) owners and bad thresholds
      ✔ a bad setting stops the run with zero transactions sent
      ✔ fuzz: the JavaScript check agrees with the on-chain constructor (40 random settings) (316ms)
    deploying
      ✔ deploys all six contracts and records address, tx, block, gas and args (58ms)
      ✔ the multisig is owned by the chosen owners, not by the deployer (51ms)
      ✔ refuses to start when the wallet cannot pay for the whole run, sending nothing
      ✔ a second run resumes: already-deployed contracts are skipped, not paid for again (58ms)
      ✔ a run that stopped half-way deploys only the missing contracts (74ms)
      ✔ an address in the record with no code (a fresh chain) is deployed again, not trusted (57ms)
      ✔ refuses to resume with different multisig settings instead of mixing two setups (53ms)
    verification and post-deploy check
      ✔ builds one Etherscan job per contract with the exact saved constructor args (53ms)
      ✔ the check passes on a good deploy and catches missing code and wrong multisig settings (63ms)
    secrets never reach git
      ✔ .env is ignored by git and .env.example holds no key
      ✔ no file in day-07 tracked by git contains something that looks like a private key
    week tour: the deployed contracts really work
      ✔ deploys exactly the reviewed code: every contract is byte-identical to its Day 01–06 original
      ✔ each of the six Week 1 contracts does its main job (101ms)

  21 passing (3s)

```

```
npx solhint 'contracts/**/*.sol'   → 0 problems
npm audit --omit=dev               → found 0 vulnerabilities
slither . --hardhat-ignore-compile → 7 contracts, 101 detectors, 1 result (W-02, accepted)
```
