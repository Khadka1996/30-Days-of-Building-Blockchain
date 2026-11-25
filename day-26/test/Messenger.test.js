// Contract tests on two real local chains (L1 = 31337, L2 = 31338).
// Focus: replay across chains and bridge risks.
const { expect } = require("chai");
const { ethers } = require("ethers");
const h = require("./helpers");
const { deployContract } = require("../lib/deploy");

describe("Day 26 — Messenger and CrossChainTodo (two chains)", function () {
  this.timeout(120000);
  let env, snap;

  before(async () => { env = await h.setup(18545, 18546); });
  after(async () => { await env?.chains.stop(); });
  beforeEach(async () => { snap = await h.snapshot(env); });
  afterEach(async () => { await h.revert(env, snap); });

  const deliver = (side, message, sigs, wallet) => env[side].messenger.connect(wallet || env.attacker[side]).receiveMessage(message, sigs);
  const twoOfThree = () => env.validators.slice(0, 2);

  describe("happy path", () => {
    it("L1 → L2: a task sent on L1 lands in the user's L1 list on L2, once", async () => {
      const { message, id } = await h.send(env, "l1", env.user.l1, { data: h.encodeText("Pay electricity bill") });
      expect(message.nonce).to.equal(0n);
      const sigs = await h.sign(message, twoOfThree());
      await expect(deliver("l2", message, sigs)).to.emit(env.l2.messenger, "MessageReceived").withArgs(id, 31337n, 0n, env.user.l1.address, env.l2.address.todo);
      const tasks = await env.l2.todo.getTasks(31337, env.user.l1.address);
      expect(tasks.map((t) => t.text)).to.deep.equal(["Pay electricity bill"]);
      expect(tasks[0].fromChainId).to.equal(31337n);
      expect(await env.l2.messenger.processed(id)).to.equal(true);
    });

    it("L2 → L1 works the same way, and nonces count up per chain", async () => {
      await h.send(env, "l2", env.user.l2);
      const { message } = await h.send(env, "l2", env.user.l2, { data: h.encodeText("Second") });
      expect(message.nonce).to.equal(1n);
      await deliver("l1", message, await h.sign(message, twoOfThree()));
      expect((await env.l1.todo.getTasks(31338, env.user.l2.address))[0].text).to.equal("Second");
    });

    it("any 2 of the 3 validators are enough (one can be offline)", async () => {
      const { message } = await h.send(env, "l1", env.user.l1);
      await deliver("l2", message, await h.sign(message, [env.validators[1], env.validators[2]]));
    });
  });

  describe("replay (same chain and across chains)", () => {
    it("the same message can't be delivered twice", async () => {
      const { message, id } = await h.send(env, "l1", env.user.l1);
      const sigs = await h.sign(message, twoOfThree());
      await deliver("l2", message, sigs);
      await expect(deliver("l2", message, sigs)).to.be.revertedWithCustomError(env.l2.messenger, "AlreadyProcessed").withArgs(id);
    });

    it("a message for L2 can't be replayed on L1 (wrong destination chain)", async () => {
      const { message } = await h.send(env, "l1", env.user.l1);
      const sigs = await h.sign(message, twoOfThree());
      await expect(deliver("l1", message, sigs)).to.be.revertedWithCustomError(env.l1.messenger, "WrongDestinationChain").withArgs(31337n, 31338n);
    });

    it("re-addressing a signed message to another chain breaks the signatures", async () => {
      const { message } = await h.send(env, "l2", env.user.l2); // L2 → L1
      const sigs = await h.sign(message, twoOfThree());
      // attacker rewrites the envelope so it looks addressed to L2's own messenger (as if from L1)
      const forged = { ...message, srcChainId: 31337n, srcMessenger: env.l1.address.messenger, dstChainId: 31338n, dstMessenger: env.l2.address.messenger };
      await expect(deliver("l2", forged, sigs)).to.be.revertedWithCustomError(env.l2.messenger, "NotAValidator");
    });

    it("a second Messenger on the same chain can't reuse the signatures (wrong destination messenger)", async () => {
      const twin = await deployContract(env.l2.owner, "Messenger", [env.validators.map((v) => v.address), 2, env.l2.owner.address]);
      await (await twin.setRemote(31337, env.l1.address.messenger)).wait();
      const { message } = await h.send(env, "l1", env.user.l1);
      const sigs = await h.sign(message, twoOfThree());
      await expect(twin.connect(env.attacker.l2).receiveMessage(message, sigs)).to.be.revertedWithCustomError(twin, "WrongDestinationMessenger");
    });

    it("re-entering receiveMessage from the target can't deliver twice", async () => {
      const bad = await deployContract(env.l2.owner, "test/ReentrantReceiver", [env.l2.address.messenger]);
      const { message, id } = await h.send(env, "l1", env.user.l1, { target: await bad.getAddress() });
      const sigs = await h.sign(message, twoOfThree());
      await (await bad.setReplay(env.l2.messenger.interface.encodeFunctionData("receiveMessage", [message, sigs]))).wait();
      await (await deliver("l2", message, sigs)).wait();
      expect(await bad.deliveries()).to.equal(1n);
      expect(await bad.replaySucceeded()).to.equal(false);
      expect(await env.l2.messenger.processed(id)).to.equal(true);
    });
  });

  describe("bridge risks: signatures and sources", () => {
    it("one validator alone (a single stolen key) can't deliver", async () => {
      const { message } = await h.send(env, "l1", env.user.l1);
      await expect(deliver("l2", message, await h.sign(message, [env.validators[0]]))).to.be.revertedWithCustomError(env.l2.messenger, "NotEnoughSignatures").withArgs(1n, 2n);
    });

    it("the same validator signing twice doesn't count as two", async () => {
      const { message } = await h.send(env, "l1", env.user.l1);
      const [s] = await h.sign(message, [env.validators[0]]);
      await expect(deliver("l2", message, [s, s])).to.be.revertedWithCustomError(env.l2.messenger, "SignersNotSortedOrDuplicate");
    });

    it("signatures from non-validators are refused", async () => {
      const { message } = await h.send(env, "l1", env.user.l1);
      const outsiders = [ethers.Wallet.createRandom(), ethers.Wallet.createRandom()];
      await expect(deliver("l2", message, await h.sign(message, outsiders))).to.be.revertedWithCustomError(env.l2.messenger, "NotAValidator");
    });

    it("changing the text after signing breaks the signatures", async () => {
      const { message } = await h.send(env, "l1", env.user.l1);
      const sigs = await h.sign(message, twoOfThree());
      const tampered = { ...message, data: h.encodeText("Send all my money to Mallory") };
      await expect(deliver("l2", tampered, sigs)).to.be.revertedWithCustomError(env.l2.messenger, "NotAValidator");
    });

    it("malleable (high-s) signatures are refused", async () => {
      const { message } = await h.send(env, "l1", env.user.l1);
      const sigs = await h.sign(message, twoOfThree());
      const N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
      const s = ethers.Signature.from(sigs[0]);
      const flipped = ethers.concat([s.r, ethers.toBeHex(N - BigInt(s.s), 32), s.v === 27 ? "0x1c" : "0x1b"]);
      await expect(deliver("l2", message, [flipped, sigs[1]])).to.be.revertedWithCustomError(env.l2.messenger, "ECDSAInvalidSignatureS");
    });

    it("a message 'from' an unknown chain or messenger is refused, even with valid signatures", async () => {
      const { message } = await h.send(env, "l1", env.user.l1);
      const fromNowhere = { ...message, srcChainId: 999n };
      await expect(deliver("l2", fromNowhere, await h.sign(fromNowhere, twoOfThree()))).to.be.revertedWithCustomError(env.l2.messenger, "UnknownSource");
      const fromFake = { ...message, srcMessenger: env.attacker.l1.address };
      await expect(deliver("l2", fromFake, await h.sign(fromFake, twoOfThree()))).to.be.revertedWithCustomError(env.l2.messenger, "UnknownSource");
    });

    it("the owner can pause both sending and receiving; others can't", async () => {
      const { message } = await h.send(env, "l1", env.user.l1);
      const sigs = await h.sign(message, twoOfThree());
      await expect(env.l2.messenger.connect(env.attacker.l2).pause()).to.be.revertedWithCustomError(env.l2.messenger, "OwnableUnauthorizedAccount");
      await (await env.l2.messenger.pause()).wait();
      await expect(deliver("l2", message, sigs)).to.be.revertedWithCustomError(env.l2.messenger, "EnforcedPause");
      await expect(h.send(env, "l2", env.user.l2)).to.be.revertedWithCustomError(env.l2.messenger, "EnforcedPause");
      await (await env.l2.messenger.unpause()).wait();
      await deliver("l2", message, sigs); // nothing was lost while paused
    });

    it("setRemote is owner-only and can't point at its own chain", async () => {
      await expect(env.l1.messenger.connect(env.attacker.l1).setRemote(31338, env.attacker.l1.address)).to.be.revertedWithCustomError(env.l1.messenger, "OwnableUnauthorizedAccount");
      await expect(env.l1.messenger.setRemote(31337, env.attacker.l1.address)).to.be.revertedWithCustomError(env.l1.messenger, "UnknownDestination");
    });

    it("weak validator sets (1 of N, duplicates, zero address) can't be deployed", async () => {
      const [a, b, c] = env.validators.map((v) => v.address);
      const o = env.l1.owner;
      for (const [vals, t] of [[[a, b, c], 1], [[a, b], 1], [[a, b, c], 4], [[a, a, b], 2], [[a, ethers.ZeroAddress, b], 2], [[], 0]]) {
        await expect(deployContract(o, "Messenger", [vals, t, o.address])).to.be.rejected;
      }
    });
  });

  describe("sending rules and the receiving app", () => {
    it("can't send to an unconnected chain, to address 0, or more than 1024 bytes", async () => {
      const m = env.l1.messenger.connect(env.user.l1);
      await expect(m.sendMessage(999, env.l2.address.todo, "0x")).to.be.revertedWithCustomError(m, "UnknownDestination");
      await expect(m.sendMessage(31338, ethers.ZeroAddress, "0x")).to.be.revertedWithCustomError(m, "BadTarget");
      await expect(m.sendMessage(31338, env.l2.address.todo, "0x" + "00".repeat(1025))).to.be.revertedWithCustomError(m, "DataTooLarge");
    });

    it("nobody but the Messenger can call onMessage (no fake deliveries)", async () => {
      await expect(env.l2.todo.connect(env.attacker.l2).onMessage(31337, env.user.l1.address, h.encodeText("x"))).to.be.revertedWithCustomError(env.l2.todo, "NotMessenger");
    });

    it("the app only accepts messages from its one trusted source chain", async () => {
      // stand-in messenger = a plain account, so we can call onMessage with any source chain
      const todo = await deployContract(env.l2.owner, "CrossChainTodo", [env.attacker.l2.address, 31337]);
      await expect(todo.connect(env.attacker.l2).onMessage(999, env.user.l1.address, h.encodeText("x"))).to.be.revertedWithCustomError(todo, "UntrustedSource").withArgs(999n);
      await (await todo.connect(env.attacker.l2).onMessage(31337, env.user.l1.address, h.encodeText("ok"))).wait();
      await expect(deployContract(env.l2.owner, "CrossChainTodo", [env.l2.address.messenger, 31338])).to.be.rejected; // can't trust itself
    });

    it("a remote sender can never write into a local user's list (per-chain namespaces)", async () => {
      await (await env.l2.todo.connect(env.user.l2).addTask("My own L2 task")).wait();
      const { message } = await h.send(env, "l1", env.user.l1, { data: h.encodeText("From L1") }); // same address as user.l2!
      await deliver("l2", message, await h.sign(message, twoOfThree()));
      expect((await env.l2.todo.getTasks(31338, env.user.l2.address)).map((t) => t.text)).to.deep.equal(["My own L2 task"]);
      expect((await env.l2.todo.getTasks(31337, env.user.l1.address)).map((t) => t.text)).to.deep.equal(["From L1"]);
    });

    it("a delivery whose target reverts rolls back fully and can be retried later", async () => {
      const r = await deployContract(env.l2.owner, "test/RevertingReceiver");
      const { message, id } = await h.send(env, "l1", env.user.l1, { target: await r.getAddress() });
      const sigs = await h.sign(message, twoOfThree());
      await expect(deliver("l2", message, sigs)).to.be.revertedWith("closed");
      expect(await env.l2.messenger.processed(id)).to.equal(false);
      await (await r.setOpen(true)).wait();
      await deliver("l2", message, sigs);
      expect(await r.deliveries()).to.equal(1n);
    });

    it("bad task text is rejected on delivery too (empty, too long)", async () => {
      for (const [text, err] of [["", "EmptyText"], ["x".repeat(281), "TextTooLong"]]) {
        const { message } = await h.send(env, "l1", env.user.l1, { data: h.encodeText(text) });
        await expect(deliver("l2", message, await h.sign(message, twoOfThree()))).to.be.revertedWithCustomError(env.l2.todo, err);
      }
    });
  });
});
