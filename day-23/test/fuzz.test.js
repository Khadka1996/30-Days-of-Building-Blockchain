// Fuzz test: random users, random blocks, random reorgs, random restarts, and an
// RPC that refuses big ranges. After every sync the index must equal the chain
// exactly — no missing events, no ghost events from orphaned blocks.
//
// Then the same fuzz is run against 5 broken copies of the indexer ("planted
// bugs"): a test that cannot catch them would be worth nothing.
const { expect } = require("chai");
const fc = require("fast-check");
const { ethers } = require("hardhat");
const { Indexer } = require("../indexer/indexer");
const { MemoryStore } = require("../indexer/store");
const h = require("./helpers");

const RUNS = Number(process.env.FUZZ_RUNS || 200);
const stats = { actions: 0, syncs: 0, reorgs: 0, restarts: 0, txs: 0 };

const action = fc.oneof(
  { weight: 4, arbitrary: fc.record({ t: fc.constant("add"), who: fc.nat(3), text: fc.string({ minLength: 1, maxLength: 20 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("complete"), who: fc.nat(3), id: fc.integer({ min: 1, max: 4 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("deposit"), who: fc.nat(3), wei: fc.bigInt({ min: 1n, max: 10n ** 18n }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("mine"), n: fc.integer({ min: 1, max: 6 }) }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant("sync") }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("restart") }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("reorg"), depth: fc.integer({ min: 1, max: 6 }), blocks: fc.integer({ min: 0, max: 4 }), add: fc.boolean() }) },
);

/** Runs one random scenario; returns a string describing the first mismatch, or null. */
async function scenario(env, actions, IndexerClass) {
  const store = new MemoryStore();
  const client = h.viemClient(h.rangeLimit(4)); // a strict RPC: at most 4 blocks per eth_getLogs
  const make = () => h.makeIndexer(env.contracts, { client, store, IndexerClass, maxRange: 8, reorgWindow: 32 });
  let ix = make();
  const forks = []; // snapshots taken before each new block: where a reorg can go back to

  async function tx(fn) {
    forks.push(await h.snapshot());
    try { await fn(); stats.txs++; } catch { forks.pop(); /* reverted call: no block was mined */ }
  }
  async function check(label) {
    await ix.sync(); stats.syncs++;
    const want = await h.truth(env.contracts);
    const got = ix.ids();
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      return `${label}: indexed ${got.length} events, chain has ${want.length}`;
    }
    return null;
  }

  let step = 0;
  for (const a of actions) {
    stats.actions++; step++;
    const user = env.signers[a.who];
    if (a.t === "add") await tx(() => env.todo.connect(user).addTask(a.text));
    else if (a.t === "complete") await tx(() => env.todo.connect(user).completeTask(a.id));
    else if (a.t === "deposit") {
      const [balance] = await env.bank.getBank(user.address);
      const unlock = balance > 0n ? 0 : (await ethers.provider.getBlock("latest")).timestamp + 86400;
      await tx(() => env.bank.connect(user).deposit(unlock, { value: a.wei }));
    } else if (a.t === "mine") {
      for (let i = 0; i < a.n; i++) { forks.push(await h.snapshot()); await h.mine(1); }
    } else if (a.t === "restart") { ix = make(); stats.restarts++; }
    else if (a.t === "reorg") {
      if (forks.length < a.depth) continue;
      const idx = forks.length - a.depth;
      await h.revert(forks[idx]);
      forks.length = idx;
      stats.reorgs++;
      await ethers.provider.send("evm_increaseTime", [7]); // new branch → new timestamps → new hashes
      if (a.add) await tx(() => env.todo.connect(env.signers[0]).addTask("new branch"));
      for (let i = 0; i < a.blocks; i++) { forks.push(await h.snapshot()); await h.mine(1); }
    } else if (a.t === "sync") {
      const bad = await check(`after step ${step} (${a.t})`);
      if (bad) return bad;
    }
  }
  return check("final sync");
}

async function fuzz(env, IndexerClass, runs, seed) {
  let failure = null;
  await fc.assert(
    fc.asyncProperty(fc.array(action, { minLength: 5, maxLength: 30 }), async (actions) => {
      const snap = await h.snapshot();
      try {
        const bad = await scenario(env, actions, IndexerClass);
        if (bad) { failure = bad; return false; }
        return true;
      } finally { await h.revert(snap); }
    }),
    { numRuns: runs, seed, endOnFailure: true },
  ).catch(() => {});
  return failure;
}

// ---- 5 planted bugs ------------------------------------------------------

/** M1: never checks for reorgs. */
class NoReorgCheck extends Indexer { async _checkReorg() { return null; } }

/** M2: notices the reorg and rewinds the cursor, but forgets to delete orphaned events. */
class RewindKeepsGhosts extends Indexer {
  _rollback(ancestor) { this.state.cursor = ancestor; for (const n of Object.keys(this.state.hashes)) if (+n > ancestor) delete this.state.hashes[n]; return { removed: 0 }; }
}

/** M3: off-by-one — starts each range one block too late. */
class OffByOne extends Indexer { _fetchRange(from, to) { return super._fetchRange(Math.min(from + 1, to), to); } }

/** M4: when the RPC refuses a range, skips it instead of splitting it. */
class SkipsRefusedRange extends Indexer {
  async _fetchRange(from, to) {
    try { return await super._fetchRange(from, to); }
    catch { const b = await this.client.getBlock({ blockNumber: BigInt(to) }); return { events: [], toHash: b.hash }; }
  }
}

/** M5: detects a reorg only when the head goes BACKWARDS (no hash check). */
class HeightOnly extends Indexer {
  async _checkReorg(head) {
    if (this.state.cursor <= head) return null;
    return this._rollback(Math.max(this.startBlock - 1, head - 1), this.state.cursor);
  }
}

describe("Day 23 — fuzzing the indexer", function () {
  this.timeout(600000);
  let env, snap;
  before(async () => { snap = await h.snapshot(); env = await h.deploy(); });
  after(async () => { await h.revert(snap); });

  it(`index == chain after every sync (${RUNS} random runs)`, async () => {
    const failure = await fuzz(env, Indexer, RUNS, 23);
    expect(failure, failure || "").to.equal(null);
    console.log(`      ${stats.actions} random actions · ${stats.txs} txs · ${stats.reorgs} reorgs · ${stats.restarts} restarts · ${stats.syncs} checked syncs · 0 mismatches`);
  });

  const mutants = { NoReorgCheck, RewindKeepsGhosts, OffByOne, SkipsRefusedRange, HeightOnly };
  for (const [name, Cls] of Object.entries(mutants)) {
    it(`catches planted bug: ${name}`, async () => {
      const failure = await fuzz(env, Cls, 40, 7);
      expect(failure, `${name} survived the fuzz`).to.not.equal(null);
      console.log(`      caught → ${failure}`);
    });
  }
});

module.exports = { NoReorgCheck, RewindKeepsGhosts, OffByOne, SkipsRefusedRange, HeightOnly };
