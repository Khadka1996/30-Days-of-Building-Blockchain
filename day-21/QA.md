# Day 21 — QA and security review

**Scope:** the new upgrade code (`contracts/upgrade/HimalStakingV1.sol`, `HimalStakingV2.sol`) and an attack on four Week 3 contracts with random action sequences: Day 15 `HimalStaking`, Day 16 `HimalLend`, Day 17 `HimalPair` and Day 20 `YieldVault` (copied unchanged into `contracts/week3/`, apart from one comment in `HimalToken`).
`contracts/naive/` and `contracts/test/` hold vulnerable-on-purpose and test-only contracts; they are excluded from lint and Slither.

**Security focus (ROADMAP):** everything from Week 3, and storage-layout clashes in upgrades.

## How the attack was run

| Tool | What it does here |
|---|---|
| **Invariant fuzzing** (fast-check) | Random sequences of up to 30 actions (users, amounts, prices, time jumps, donations, greedy requests). After **every** action the contract's invariants are checked. On a failure, fast-check shrinks the sequence to the shortest one that still breaks it. |
| **Differential fuzzing** | The same actions go to the Day 15 contract and to the V1 proxy **in the same block**; both must agree on every number, including after a V1 → V2 upgrade in the middle of a run. |
| **Mutation check** (`npm run mutate`) | Plants 15 realistic bugs one at a time (in the Week 3 contracts and in the upgrade code). The test suite must fail for each. Its first run missed 3 of 15, which showed where the invariants were too weak (T-01). |
| **OpenZeppelin upgrades plugin** | Compares the storage layout of V1 and the new version before any upgrade. |
| solhint · npm audit · Slither | Lint, dependency check, static analysis. |

### Invariants checked after every action

| Contract | Invariants |
|---|---|
| Day 15 staking + V1/V2 proxy | staked total = what users put in, and the HIM is really held · every balance matches the model · rewards promised ≤ HRW held · proxy and original agree on `rewardPerToken` and every `earned` · at the end everyone gets every HIM back, both paid the same HRW, never more than funded, and the rest is still in the contract |
| Day 16 lending | HUSD held ≥ `totalCash` · HIM held = all collateral · lender shares and debt shares add up · reserves covered · nobody is above their limit after a borrow or a collateral withdrawal · borrowing 1 wei over the limit always fails · a lender's share never loses value unless bad debt is written off openly |
| Day 17 swap pool | tokens held ≥ reserves · the 1,000 locked LP shares stay locked, reserves never 0 · the value of an LP share (√(r0·r1)/supply) never drops · a fair swap always works · a swap asking 1 wei more than the formula always fails |
| Day 20 vault | `totalAssets` ≤ real cash + strategy · all shares together ≤ `totalAssets` · the vault's books never exceed what it and the strategy really hold · share price never drops (no losses in this suite) · `harvest` never makes new profit count at once · a deposit + redeem in the next block earns at most the profit unlocked in that block · at the end, users never take out more than they put in plus interest |

## Findings

| ID | Severity | Found by | Description | Fix | Proving test |
|---|---|---|---|---|---|
| F-01 | High | Review (UUPS) | If `_authorizeUpgrade` is left empty, **anyone** can upgrade the proxy. The test upgrades to a `Drainer` contract and takes all **1,000 HIM** staked. | `_authorizeUpgrade` is `onlyOwner`. | `Upgrade.test.js` › F-01 (attack on `HimalStakingV1OpenUpgrade`, then the fixed V1 refuses with `OwnableUnauthorizedAccount`) |
| F-02 | High | Review (deploy) | Creating the proxy first and calling `initialize` in a second transaction leaves a gap: whoever calls `initialize` first becomes **owner**, and so controls upgrades. | Deploy with `upgrades.deployProxy`, which passes the `initialize` call to the `ERC1967Proxy` constructor (one transaction). | `Upgrade.test.js` › F-02 |
| F-03 | Medium | Review (UUPS) | The logic contract itself could be initialized by anyone (it has its own storage). With OpenZeppelin 5 it cannot be upgraded directly (`onlyProxy`), so funds are not at risk, but a stranger "owning" the official implementation is a phishing and confusion risk; on older versions this was critical (self-destruct). | Constructor calls `_disableInitializers()` in V1 and V2. | `Upgrade.test.js` › F-03 (`InvalidInitialization`, and `UUPSUnauthorizedCallContext` on a direct upgrade) |
| F-04 | High | Plugin + test | **Storage layout clash.** A rewritten V2 that puts a new variable (`withdrawFeeBps`) at the top shifts every variable by one slot: `stakingToken()` now returns the **reward token**, `totalStaked` reads **0**, and Ram's withdrawal reverts, so all 4,000 HIM are stuck. | V2 **inherits** V1 and only **appends** variables; `upgrades.validateUpgrade` / `upgradeProxy` refuse the clash ("Inserted `withdrawFeeBps`"). The slot of every V1 variable is written next to it in the code. | `Upgrade.test.js` › F-04 |
| F-05 | Medium | Review (UUPS) | In UUPS the upgrade code lives in the logic contract. Upgrading to a contract **without** it (for example the HIM token by mistake) would freeze the proxy forever. | Use OpenZeppelin's `UUPSUpgradeable`, which checks `proxiableUUID` on the new contract and reverts with `ERC1967InvalidImplementation`. No custom upgrade code. | `Upgrade.test.js` › F-05 |
| F-06 | Medium | Review (upgrade) | The V2 setup (`initializeV2`, a `reinitializer(2)`) had no owner check. If the upgrade and the setup are two transactions, anyone can run the setup first and make themselves **guardian**, and the owner can never run it again. | `initializeV2` is `onlyOwner`, and it is sent **with** the upgrade (`upgradeToAndCall` / `upgradeProxy({ call })`). | `Upgrade.test.js` › F-06 |
| T-01 | Test gap | Mutation check | The first version of the tests missed 3 of 15 planted bugs: a vault that counts profit at once, a vault that forgets money it pulled back from the strategy, and an open `initializeV2` after an upgrade sent without setup. | Added three checks: `harvest` never raises the value by more than the profit already locked; the vault's books never exceed real holdings; a stranger cannot run `initializeV2` even after a bare upgrade. Now 15 of 15 are caught. | `Invariants.Vault.test.js` (harvest, I4), `Upgrade.test.js` › F-06 |
| T-02 | Info (my invariant was wrong) | Fuzzer | My first vault rule said "a deposit + immediate redeem never gains anything". fast-check shrank a counter-example to 4 steps: 1 HUSD interest is harvested into an empty vault, then a 1 HUSD round trip gets back **0.0000463 HUSD** extra. That is correct behaviour: the user held shares for one block, and one second of the 6-hour unlock (1 HUSD ÷ 21,600) is exactly that amount. | Rule made precise: a one-block round trip earns **at most the profit unlocked during that block**. Contract unchanged. | `Invariants.Vault.test.js` › roundtrip |
| T-03 | Info (known design) | Fuzzer | In the Day 17 pool, tokens sent without `sync()` count as input for the **next** swap. After a 1 HUSD donation, a swap asking 1 wei more than the formula succeeded. This is Uniswap V2 behaviour (`skim` / `sync` exist for it): unsynced tokens belong to whoever acts next. Users who swap through the router are not affected. | Documented as a known issue; the test lets the swapper `skim` first so the 1-wei check is about the swap alone. | `Invariants.Swap.test.js` › swap / greedy |

**Result of the Week 3 attack:** across all random runs, **0 invariant breaks** in the four Week 3 contracts. They had already been reviewed on their own days; today's value is a safety net that runs every time the code changes, and the mutation check shows it would catch the bugs that matter (15 of 15).

## Static analysis

`slither` 0.11.6 reports **0 results on the new Day 21 code** (upgrade contracts). On the four Week 3 contracts, copied unchanged, it now reports 4 notes (a newer Slither than on Days 15–17); all reviewed, none needs a change:

- `reentrancy-balance` in `HimalLend._pullExact`: every caller is `nonReentrant`, and a token that re-enters can only make the "exact amount arrived" check fail, which reverts.
- `reentrancy-no-eth` / `reentrancy-benign` in `HimalPair.swap` and `burn`: reserves are updated after the transfers, exactly like Uniswap V2; every state-changing pool function is `nonReentrant`. A token with transfer hooks could read stale `getReserves()` in the middle of a swap (read-only re-entrancy): logged as a known issue below.
- `reentrancy-events` in `HimalStaking.recoverERC20`: owner-only, event after the transfer; informational.

## Known issues and limits

- **Read-only re-entrancy in the swap pool** (Low): another protocol using `HimalPair.getReserves()` as a price could read old reserves during a swap of a token with transfer hooks. The Week 3 tokens have no hooks; a real pool would add a lock check to the view, as Uniswap V2's `lock` does for state changes.

- **Not covered today:** the Day 18 flash lender and the Day 19 stablecoin have their own tests and fuzzing on those days, but no Day 21 invariant suite.
- **Owner is one key.** The owner can upgrade to any code. Real protocols put upgrades behind a multisig and a timelock (Day 4 and Day 14 ideas), so users can see a new version and leave before it runs.
- **Pause is for new stakes only** by design: withdrawals and claims can never be paused.
- **Interest that arrives while the vault is empty** goes to the first depositor over 6 hours (T-02). Nobody else owns shares, so nobody loses.
- **Fuzzing is random, not a proof.** More runs: `npm run fuzz` (200 runs per suite). A failing seed can be replayed with `FUZZ_SEED=<seed>`.
- The plugin notes that `reinitializer` functions are not validated as initializers by default; `initializeV2` only sets V2's own variable, so this is fine.

## Final green output

```
$ npm test
  Day 21 — invariants: Day 16 lending pool
      lending: 263 random actions, 14 greedy borrows blocked, 8 liquidations, 0 invariant breaks
    ✔ 25 random runs of up to 30 actions: backed, nobody borrows past the limit, lenders only lose to bad debt (5313ms)

  Day 21 — invariants: Day 15 staking and its UUPS proxy, side by side
      staking: 343 random actions, 14 upgrades mid-run, 0 invariant breaks
    ✔ 25 random runs of up to 30 actions: solvent, fair, and identical across the upgrade (9376ms)

  Day 21 — invariants: Day 17 swap pool
      swap: 376 random actions, 46 greedy swaps blocked, 0 invariant breaks
    ✔ 25 random runs of up to 30 actions: books match, LP value never drops, greedy swaps fail (3586ms)

  Day 21 — invariants: Day 20 yield vault
      vault: 332 random actions, 41 one-block round trips, 0 invariant breaks
    ✔ 25 random runs of up to 30 actions: backed, share price never drops, no free money (3610ms)

  Day 21 — UUPS upgrade: V1 → V2 without moving anyone's tokens
    ✔ V1 behind a proxy works like Day 15 and reports version 1.0.0 (74ms)
    ✔ the safe upgrade keeps the address, every balance and every reward, then adds the pause (64ms)
    ✔ F-04: the plugin refuses a V2 that inserts a variable, and forcing it in breaks the staking
    ✔ F-01: if _authorizeUpgrade is empty, anyone can upgrade to a drainer and take every staked token (120ms)
    ✔ F-02: a proxy created first and initialized later can be taken over by whoever initializes first
    ✔ F-03: the logic contract itself is locked: nobody can initialize or upgrade it directly
    ✔ F-05: upgrading to a contract that is not UUPS is refused, so the proxy cannot be bricked (62ms)
    ✔ F-06: the V2 setup must be owner-only and sent with the upgrade, or anyone picks the guardian (39ms)

  12 passing (22s)

$ npm run fuzz
      lending: 2969 random actions, 125 greedy borrows blocked, 82 liquidations, 0 invariant breaks
    ✔ 200 random runs of up to 30 actions: backed, nobody borrows past the limit, lenders only lose to bad debt (49473ms)
      staking: 2714 random actions, 95 upgrades mid-run, 0 invariant breaks
    ✔ 200 random runs of up to 30 actions: solvent, fair, and identical across the upgrade (77421ms)
      swap: 2904 random actions, 493 greedy swaps blocked, 0 invariant breaks
    ✔ 200 random runs of up to 30 actions: books match, LP value never drops, greedy swaps fail (29872ms)
      vault: 2765 random actions, 334 one-block round trips, 0 invariant breaks
    ✔ 200 random runs of up to 30 actions: backed, share price never drops, no free money (35556ms)
  4 passing (3m)

$ npm run mutate
caught  staking: withdraw forgets to lower totalStaked
caught  staking: a claim does not reset your rewards
caught  proxy V1: unallocated rewards paid twice
caught  swap: no 0.3% fee in the k check
caught  swap: the 1,000 first LP shares are not locked
caught  lending: borrow skips the health check
caught  lending: collateral withdrawal skips the health check
caught  lending: redeem forgets the cash left
caught  vault: profit counted at once (no 6-hour unlock)
caught  vault: withdrawal forgets money left the strategy
caught  upgrade: anyone can upgrade (no onlyOwner)
caught  upgrade: logic contract not locked
caught  upgrade: anyone can run the V2 setup
caught  upgrade: anyone can pause
caught  upgrade: the pause does nothing
mutation check: 15 of 15 planted bugs caught

$ npm run lint
(0 problems)

$ npm audit --omit=dev
found 0 vulnerabilities

$ npm run slither -- --filter-paths "contracts/week3|contracts/test|contracts/naive|node_modules"
INFO:Slither:. analyzed (41 contracts with 101 detectors), 0 result(s) found
```
