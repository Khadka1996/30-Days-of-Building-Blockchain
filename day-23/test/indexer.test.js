const { expect } = require("chai");
const { ethers } = require("hardhat");
const { FileStore, MemoryStore } = require("../indexer/store");
const { Indexer, isRangeError } = require("../indexer/indexer");
const h = require("./helpers");
const fs = require("fs");
const os = require("os");
const path = require("path");

describe("Day 23 — event indexer", function () {
  let env, snap;
  const week = 7 * 86400;

  beforeEach(async () => { snap = await h.snapshot(); env = await h.deploy(); });
  afterEach(async () => { await h.revert(snap); });

  async function unlockTime() { return (await ethers.provider.getBlock("latest")).timestamp + week; }

  describe("reading events", () => {
    it("indexes and decodes every event of both contracts, newest first", async () => {
      const [a, b] = env.signers;
      await env.todo.connect(a).addTask("Pay electricity bill");
      await env.todo.connect(a).completeTask(1);
      await env.bank.connect(b).deposit(await unlockTime(), { value: ethers.parseEther("1.5") });
      await env.todo.connect(a).deleteTask(1);

      const ix = h.makeIndexer(env.contracts);
      const r = await ix.sync();
      expect(r.added).to.equal(4);
      expect(ix.ids()).to.deep.equal(await h.truth(env.contracts));

      const feed = ix.feed();
      expect(feed.map((e) => e.event)).to.deep.equal(["TaskDeleted", "Deposited", "TaskCompleted", "TaskAdded"]);
      const added = feed[3];
      expect(added.contract).to.equal("TodoList");
      expect(added.args).to.deep.equal({ owner: a.address, id: "1", text: "Pay electricity bill" });
      expect(feed[1].args.amount).to.equal(ethers.parseEther("1.5").toString()); // bigint → exact string
    });

    it("ignores events from other contracts, even with the same event signature", async () => {
      const other = await ethers.deployContract("TodoList"); // a copy we do NOT index
      await other.addTask("not ours");
      await env.todo.addTask("ours");
      const ix = h.makeIndexer(env.contracts);
      await ix.sync();
      expect(ix.feed().map((e) => e.args.text)).to.deep.equal(["ours"]);
    });

    it("sees a new block on the very next sync (no cached block number)", async () => {
      // A default viem client caches eth_blockNumber for 4 s; a live feed must not.
      const { createPublicClient, custom } = require("viem");
      const { network } = require("hardhat");
      const client = createPublicClient({ transport: custom(network.provider) }); // default cache settings
      const ix = h.makeIndexer(env.contracts, { client });
      await ix.sync();
      await env.todo.addTask("right now");
      const r = await ix.sync();
      expect(r.added).to.equal(1);
      expect(r.head).to.equal(await h.blockNumber());
    });

    it("marks events pending until they have enough confirmations", async () => {
      await env.todo.addTask("fresh");
      const ix = h.makeIndexer(env.contracts, { confirmations: 3 });
      await ix.sync();
      expect(ix.feed()[0]).to.include({ status: "pending", confirmations: 1 });
      await h.mine(1); await ix.sync();
      expect(ix.feed()[0]).to.include({ status: "pending", confirmations: 2 });
      await h.mine(1); await ix.sync();
      expect(ix.feed()[0]).to.include({ status: "confirmed", confirmations: 3 });
    });

    it("keeps the exact text of a task, HTML and emoji included", async () => {
      const nasty = `<img src=x onerror="alert(1)"> 😀 "quotes" & ampersands`;
      await env.todo.addTask(nasty);
      const ix = h.makeIndexer(env.contracts);
      await ix.sync();
      expect(ix.feed()[0].args.text).to.equal(nasty);
    });
  });

  describe("missed events", () => {
    it("splits a big backfill when the RPC limits the block range (nothing skipped)", async () => {
      for (let i = 0; i < 6; i++) { await env.todo.addTask(`task ${i}`); await h.mine(20); }
      const client = h.viemClient(h.rangeLimit(10));
      const ix = h.makeIndexer(env.contracts, { client, maxRange: 1000 });
      await ix.sync();
      expect(ix.ids()).to.deep.equal(await h.truth(env.contracts));
      expect(ix.ids()).to.have.length(6);
      expect(ix.range).to.be.at.most(10);
    });

    it("does not swallow other RPC errors: the cursor stays put and the next sync retries", async () => {
      await env.todo.addTask("one");
      let fail = true;
      const client = h.viemClient({ before: (m) => { if (m === "eth_getLogs" && fail) throw new Error("connection reset"); } });
      const ix = h.makeIndexer(env.contracts, { client });
      await ix.init();
      const cursor = ix.state.cursor;
      let caught;
      try { await ix.sync(); } catch (e) { caught = e; }
      expect(caught, "sync should throw").to.exist;
      expect(ix.state.cursor).to.equal(cursor);
      fail = false;
      await ix.sync();
      expect(ix.ids()).to.deep.equal(await h.truth(env.contracts));
    });

    it("catches up after a restart from the saved cursor, with no duplicates", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "day23-"));
      const file = path.join(dir, "index.json");
      await env.todo.addTask("before restart");

      const first = h.makeIndexer(env.contracts, { store: new FileStore(file) });
      await first.sync();

      // indexer is "down" while people keep using the app
      await env.todo.addTask("while down 1");
      await env.bank.deposit(await unlockTime(), { value: 1000n });
      await env.todo.addTask("while down 2");

      const second = h.makeIndexer(env.contracts, { store: new FileStore(file) });
      const r = await second.sync();
      expect(r.added).to.equal(3);
      expect(second.ids()).to.deep.equal(await h.truth(env.contracts));
      await second.sync(); // running again changes nothing
      expect(second.ids()).to.have.length(4);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("never skips a block that is mined while a sync is running", async () => {
      // A busy chain: right after every eth_getLogs, someone adds a task.
      let busy = true;
      const client = h.viemClient({
        after: async (m) => { if (m === "eth_getLogs" && busy) { busy = false; await env.todo.addTask("mined mid-sync"); } },
      });
      await env.todo.addTask("first");
      const ix = h.makeIndexer(env.contracts, { client });
      await ix.sync();          // sees "first"; the new block is past its fixed head
      expect(ix.ids()).to.have.length(1);
      await ix.sync();          // picks the new one up
      expect(ix.ids()).to.deep.equal(await h.truth(env.contracts));
      expect(ix.ids()).to.have.length(2);
    });

    it("starts over when the saved index belongs to other contracts", async () => {
      const store = new MemoryStore();
      const ix1 = h.makeIndexer(env.contracts, { store });
      await env.todo.addTask("old deployment");
      await ix1.sync();
      const fresh = await h.deploy(); // redeploy → new addresses
      const ix2 = h.makeIndexer(fresh.contracts, { store });
      await ix2.sync();
      expect(ix2.ids()).to.deep.equal(await h.truth(fresh.contracts));
      expect(ix2.ids()).to.have.length(0);
    });
  });

  describe("chain reorganisations", () => {
    it("removes events from orphaned blocks and adds the new branch", async () => {
      const [a, b] = env.signers;
      await env.todo.connect(a).addTask("safe");
      const ix = h.makeIndexer(env.contracts);
      await ix.sync();

      const fork = await h.snapshot();
      await env.todo.connect(b).addTask("will vanish");
      await env.bank.connect(b).deposit(await unlockTime(), { value: ethers.parseEther("2") });
      await ix.sync();
      expect(ix.feed().map((e) => e.event)).to.deep.equal(["Deposited", "TaskAdded", "TaskAdded"]);

      await h.revert(fork); // the 2 blocks are gone
      await ethers.provider.send("evm_increaseTime", [15]);
      await env.todo.connect(a).addTask("winning branch");
      await h.mine(2);

      const r = await ix.sync();
      expect(r.reorg).to.include({ removed: 2, depth: 2 });
      expect(ix.ids()).to.deep.equal(await h.truth(env.contracts));
      expect(ix.feed().map((e) => e.args.text)).to.deep.equal(["winning branch", "safe"]);
    });

    it("handles a reorg to a SHORTER chain (head goes backwards)", async () => {
      await env.todo.addTask("keep");
      const ix = h.makeIndexer(env.contracts);
      const fork = await h.snapshot();
      await env.todo.addTask("gone"); await h.mine(5);
      await ix.sync();
      await h.revert(fork);
      const r = await ix.sync();
      expect(r.reorg.removed).to.equal(1);
      expect(ix.ids()).to.deep.equal(await h.truth(env.contracts));
    });

    it("detects a reorg that only changes OLD blocks below the cursor", async () => {
      // Same height as before, but a different block deeper down: only the
      // hash chain (not the block number) can tell.
      await env.todo.addTask("keep");
      const ix = h.makeIndexer(env.contracts);
      await ix.sync();
      const fork = await h.snapshot();
      await env.todo.addTask("old branch"); await h.mine(3);
      await ix.sync();
      const height = await h.blockNumber();
      await h.revert(fork);
      await ethers.provider.send("evm_increaseTime", [30]);
      await env.todo.addTask("new branch"); await h.mine(3);
      expect(await h.blockNumber()).to.equal(height);
      await ix.sync();
      expect(ix.ids()).to.deep.equal(await h.truth(env.contracts));
      expect(ix.feed().map((e) => e.args.text)).to.deep.equal(["new branch", "keep"]);
    });

    it("re-indexes from the start when a reorg is deeper than the saved window", async () => {
      await env.todo.addTask("keep");
      const ix = h.makeIndexer(env.contracts, { reorgWindow: 4, maxRange: 2 });
      const fork = await h.snapshot();
      await env.todo.addTask("gone"); await h.mine(12);
      await ix.sync();
      await h.revert(fork);
      await ethers.provider.send("evm_increaseTime", [15]);
      await h.mine(14);
      const r = await ix.sync();
      expect(r.reorg.fromBlock).to.equal(ix.startBlock);
      expect(ix.ids()).to.deep.equal(await h.truth(env.contracts));
    });

    // The chain reorganises between reading block `to` and reading its logs.
    async function midFetchReorg(IndexerClass) {
      await env.todo.addTask("keep");
      let fork = null;
      let armed = true;
      const client = h.viemClient({
        // between reading block `to` and its logs, the chain reorganises
        after: async (m) => {
          if (m === "eth_getLogs" && armed && fork) {
            armed = false;
            await h.revert(fork);
            await ethers.provider.send("evm_increaseTime", [15]);
            await env.todo.addTask("replacement"); await h.mine(1);
          }
        },
      });
      const ix = h.makeIndexer(env.contracts, { client, IndexerClass });
      await ix.sync();
      fork = await h.snapshot();
      await env.todo.addTask("orphan"); await h.mine(1);
      await ix.sync();
      await ix.sync();
      return { ix, want: await h.truth(env.contracts) };
    }

    it("discards a range whose last block changed while it was being read", async () => {
      const { ix, want } = await midFetchReorg();
      expect(ix.ids()).to.deep.equal(want);
      expect(ix.feed().map((e) => e.args.text)).to.not.include("orphan");
    });

    it("(planted bug) without the second read of block `to`, the orphan stays forever", async () => {
      class NoDoubleRead extends Indexer {
        async _fetchRange(from, to) {
          const logs = await this.client.getLogs({ address: this.addresses, events: this.abiEvents, fromBlock: BigInt(from), toBlock: BigInt(to), strict: true });
          const block = await this.client.getBlock({ blockNumber: BigInt(to) });
          return { toHash: block.hash, events: logs.map((l) => ({ id: `${l.blockHash}:${l.logIndex}`, blockNumber: Number(l.blockNumber), blockHash: l.blockHash, logIndex: l.logIndex, args: {} })) };
        }
      }
      const { ix, want } = await midFetchReorg(NoDoubleRead);
      expect(ix.ids()).to.not.deep.equal(want);
    });

    it("recovers when the local node is restarted (same chain id, new chain)", async () => {
      await env.todo.addTask("on the old chain");
      const ix = h.makeIndexer(env.contracts);
      await ix.sync();
      await h.revert(snap); snap = await h.snapshot(); // wipe back to before deploy
      env = await h.deploy();                          // same addresses, new blocks
      await env.todo.addTask("on the new chain");
      await ix.sync();
      expect(ix.ids()).to.deep.equal(await h.truth(env.contracts));
      expect(ix.feed().map((e) => e.args.text)).to.deep.equal(["on the new chain"]);
    });
  });

  describe("helpers", () => {
    it("recognises the range errors real RPCs send", () => {
      for (const msg of [
        "query returned more than 10000 results",
        "eth_getLogs block range too large",
        "exceed maximum block range: 5000",
        "Log response size exceeded",
        "limit exceeded",
      ]) expect(isRangeError(new Error(msg)), msg).to.equal(true);
      expect(isRangeError(new Error("connection reset"))).to.equal(false);
      expect(isRangeError(new Error("execution reverted"))).to.equal(false);
    });
  });
});
