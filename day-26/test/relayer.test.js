// Off-chain tests: validators + relayer (viem) carrying messages both ways,
// confirmations, fake events, reorgs, outages, retries, and the L2 cost model.
const { expect } = require("chai");
const { ethers } = require("ethers");
const h = require("./helpers");
const { deployContract } = require("../lib/deploy");
const { createValidator, createRelayer } = require("../relayer/relayer");
const { compare, calldataGas } = require("../lib/gas-model");
const { sendRaw } = require("../lib/tx");

describe("Day 26 — validators, relayer and the L2 cost model", function () {
  this.timeout(120000);
  let env, snap;

  before(async () => { env = await h.setup(18645, 18646); });
  after(async () => { await env?.chains.stop(); });
  beforeEach(async () => { snap = await h.snapshot(env); });
  afterEach(async () => { await h.revert(env, snap); });

  function validators(from, to, { keys = env.validators, srcMessenger, confirmations = 2 } = {}) {
    return keys.map((v) => createValidator({
      privateKey: v.privateKey, src: env.chains[from], srcMessenger: srcMessenger || env[from].address.messenger,
      dstChainId: env.chains[to].chainId, dstMessenger: env[to].address.messenger, confirmations,
    }));
  }
  function relayer(from, to, opts = {}) {
    return createRelayer({
      src: env.chains[from], dst: env.chains[to], srcMessenger: env[from].address.messenger, dstMessenger: env[to].address.messenger,
      validators: opts.validators || validators(from, to), threshold: 2, allowedTargets: opts.allowedTargets, submitterKey: env.submitterKey, confirmations: 2,
    });
  }

  it("delivers L1 → L2 and L2 → L1, only after 2 confirmations, exactly once", async () => {
    const up = relayer("l1", "l2"), down = relayer("l2", "l1");
    await h.send(env, "l1", env.user.l1, { data: h.encodeText("From L1") });
    await h.send(env, "l2", env.user.l2, { data: h.encodeText("From L2") });
    expect(await up.poll()).to.deep.equal([]); // 1 confirmation: too early (could still be reorganised)
    await h.mine(env.chains.l1); await h.mine(env.chains.l2);
    const [a] = await up.poll(); const [b] = await down.poll();
    expect([a.status, b.status]).to.deep.equal(["delivered", "delivered"]);
    expect((await env.l2.todo.getTasks(31337, env.user.l1.address))[0].text).to.equal("From L1");
    expect((await env.l1.todo.getTasks(31338, env.user.l2.address))[0].text).to.equal("From L2");
    expect(await up.poll()).to.deep.equal([]);           // nothing new
    const again = relayer("l1", "l2");                    // a second relayer starting from block 0
    expect((await again.poll()).map((r) => r.status)).to.deep.equal(["already delivered"]); // no double delivery, no gas paid
  });

  it("validators refuse events from a fake Messenger, even if they look perfect", async () => {
    const fake = await deployContract(env.attacker.l1, "test/FakeMessenger");
    const m = { srcChainId: 31337n, srcMessenger: env.l1.address.messenger, dstChainId: 31338n, dstMessenger: env.l2.address.messenger,
      nonce: 77n, sender: env.attacker.l1.address, target: env.l2.address.todo, data: h.encodeText("fake") };
    const r = await (await fake.fake(m, h.hashMessage(m))).wait();
    await h.mine(env.chains.l1, 3);
    for (const v of validators("l1", "l2")) {
      await expect(v.attest(r.hash, r.logs[0].index)).to.be.rejectedWith("log not from the source Messenger");
    }
    expect(await relayer("l1", "l2").poll()).to.deep.equal([]); // the relayer only reads the real Messenger
  });

  it("each validator waits for confirmations on its own (it doesn't trust the relayer to wait)", async () => {
    const { receipt } = await h.send(env, "l1", env.user.l1);
    const [v] = validators("l1", "l2");
    await expect(v.attest(receipt.hash, receipt.logs[0].index)).to.be.rejectedWith("not enough confirmations");
    await h.mine(env.chains.l1, 1);
    expect((await v.attest(receipt.hash, receipt.logs[0].index)).signature).to.match(/^0x[0-9a-f]{130}$/);
  });

  it("validators refuse a message that a reorg removed", async () => {
    const before = await env.chains.l1.provider.send("evm_snapshot", []);
    const { receipt } = await h.send(env, "l1", env.user.l1, { data: h.encodeText("ghost") });
    await env.chains.l1.provider.send("evm_revert", [before]); // a reorg: the block with the message is gone
    await h.mine(env.chains.l1, 3);
    const [v] = validators("l1", "l2");
    await expect(v.attest(receipt.hash, receipt.logs[0].index)).to.be.rejected;
    expect(await relayer("l1", "l2").poll()).to.deep.equal([]);
  });

  it("still delivers with one validator offline or misconfigured; stops (and pays nothing) with two", async () => {
    const vs = validators("l1", "l2");
    const broken = validators("l1", "l2", { srcMessenger: env.attacker.l1.address });
    await h.send(env, "l1", env.user.l1);
    await h.mine(env.chains.l1, 2);
    const ok = relayer("l1", "l2", { validators: [broken[0], vs[1], vs[2]] });
    expect((await ok.poll())[0].status).to.equal("delivered");

    await h.send(env, "l1", env.user.l1, { data: h.encodeText("second") });
    await h.mine(env.chains.l1, 2);
    const submitter = new ethers.Wallet(env.submitterKey, env.chains.l2.provider);
    const balance = await env.chains.l2.provider.getBalance(submitter.address);
    const stuck = relayer("l1", "l2", { validators: [broken[0], broken[1], vs[2]] });
    const [res] = await stuck.poll(); // only 1 of 3 validators agrees: below the 2-of-3 threshold
    expect([res.status, res.reason]).to.deep.equal(["failed", "not enough validators agreed"]);
    expect(await env.chains.l2.provider.getBalance(submitter.address)).to.equal(balance);
  });

  it("a delivery that fails (target reverts) is retried on the next poll, not skipped", async () => {
    const r = await deployContract(env.l2.owner, "test/RevertingReceiver");
    await h.send(env, "l1", env.user.l1, { target: await r.getAddress() });
    await h.mine(env.chains.l1, 2);
    const rel = relayer("l1", "l2");
    expect((await rel.poll())[0].status).to.equal("failed"); // simulated first: no gas wasted
    await (await r.setOpen(true)).wait();
    expect((await rel.poll())[0].status).to.equal("delivered");
    expect(await r.deliveries()).to.equal(1n);
  });

  it("F-1: a message that keeps failing does not block the messages after it", async () => {
    const r = await deployContract(env.l2.owner, "test/RevertingReceiver"); // stays closed: always reverts
    await h.send(env, "l1", env.attacker.l1, { target: await r.getAddress() });
    await h.send(env, "l1", env.user.l1, { data: h.encodeText("Must still arrive") });
    await h.mine(env.chains.l1, 2);
    const rel = relayer("l1", "l2");
    const res = await rel.poll();
    expect(res.map((x) => x.status)).to.deep.equal(["failed", "delivered"]);
    expect((await env.l2.todo.getTasks(31337, env.user.l1.address))[0].text).to.equal("Must still arrive");
    await (await r.setOpen(true)).wait();                  // the stuck one is retried later, not lost
    expect((await rel.poll()).map((x) => x.status)).to.deep.equal(["delivered"]);
  });

  it("F-2: with a target allow-list, the relayer never pays for messages to other contracts", async () => {
    const r = await deployContract(env.l2.owner, "test/RevertingReceiver");
    await (await r.setOpen(true)).wait();
    await h.send(env, "l1", env.attacker.l1, { target: await r.getAddress() });
    await h.mine(env.chains.l1, 2);
    const rel = relayer("l1", "l2", { allowedTargets: [env.l2.address.todo] });
    const submitter = new ethers.Wallet(env.submitterKey, env.chains.l2.provider);
    const balance = await env.chains.l2.provider.getBalance(submitter.address);
    expect((await rel.poll()).map((x) => x.status)).to.deep.equal(["not paid for (target not allowed)"]);
    expect(await env.chains.l2.provider.getBalance(submitter.address)).to.equal(balance);
    expect(await r.deliveries()).to.equal(0n); // anyone else may still deliver it: the message itself is valid
  });

  it("L2 cost model: same gas on both chains, the L2 is far cheaper, and L1 data is most of the L2 fee", async () => {
    const a = new ethers.Wallet(h.devWallet(3, env.chains.l1.provider).privateKey, env.chains.l1.provider);
    const b = new ethers.Wallet(a.privateKey, env.chains.l2.provider);
    const data = env.l1.todo.interface.encodeFunctionData("addTask", ["Buy momo"]);
    const on1 = await sendRaw(a, { to: env.l1.address.todo, data });
    const on2 = await sendRaw(b, { to: env.l2.address.todo, data });
    expect(on1.receipt.gasUsed).to.equal(on2.receipt.gasUsed); // same EVM, same code, same gas
    const c = compare(on2.receipt.gasUsed, on2.raw);
    expect(c.times).to.be.greaterThan(10);
    expect(c.dataShare).to.be.greaterThan(0.5);
    expect(calldataGas("0x00ff")).to.equal(20); // 4 per zero byte + 16 per non-zero byte
  });
});
