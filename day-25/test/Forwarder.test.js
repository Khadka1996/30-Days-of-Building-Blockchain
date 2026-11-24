// Contract tests: the Forwarder (EIP-712 + ERC-2771) and the gasless to-do list.
// The relayer here is a plain Hardhat account calling execute() directly, so these
// tests check what the CHAIN guarantees, whatever the relayer does.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { encodeFunctionData } = require("viem");
const h = require("./helpers");

describe("Forwarder + GaslessTodoList (on-chain rules)", function () {
  let env, relayer, user, snap;

  beforeEach(async () => {
    snap = await h.snapshot();
    env = await h.deploy();
    relayer = env.signers[9];
    user = h.newUser();
  });
  afterEach(async () => { await h.revert(snap); });

  const exec = (s, opts = {}) => env.forwarder.connect(relayer).execute(s.req, s.signature, opts);

  describe("gasless happy path", () => {
    it("a user with 0 ETH adds a task; the task is the USER's, the relayer pays", async () => {
      expect(await ethers.provider.getBalance(user.address)).to.equal(0n);
      const before = await ethers.provider.getBalance(relayer.address);
      const s = await h.signRequest(env, user, { args: ["Buy momo for the team"] });
      expect(await env.forwarder.verify(s.req, s.signature)).to.equal(true);
      await expect(exec(s)).to.emit(env.forwarder, "Executed").withArgs(user.address, env.todoInfo.address, 0n, relayer.address)
        .and.to.emit(env.todo, "TaskAdded").withArgs(user.address, 1n, "Buy momo for the team");

      const tasks = await env.todo.getTasks(user.address);
      expect(tasks.map((t) => t.text)).to.deep.equal(["Buy momo for the team"]);
      expect(await env.todo.taskCount(relayer.address)).to.equal(0n);
      expect(await env.todo.taskCount(env.forwarderInfo.address)).to.equal(0n);
      expect(await ethers.provider.getBalance(user.address)).to.equal(0n);
      expect(await ethers.provider.getBalance(relayer.address)).to.be.lessThan(before);
      expect(await env.forwarder.nonces(user.address)).to.equal(1n);
    });

    it("complete and delete also work gasless, and direct calls (paying your own gas) still work", async () => {
      await exec(await h.signRequest(env, user, { args: ["one"] }));
      await exec(await h.signRequest(env, user, { args: ["two"] }));
      await exec(await h.signRequest(env, user, { fn: "completeTask", args: [1n] }));
      await exec(await h.signRequest(env, user, { fn: "deleteTask", args: [2n] }));
      const tasks = await env.todo.getTasks(user.address);
      expect(tasks.length).to.equal(1);
      expect(tasks[0].completed).to.equal(true);

      const alice = env.signers[0];
      await env.todo.connect(alice).addTask("I pay my own gas");
      expect((await env.todo.getTasks(alice.address))[0].text).to.equal("I pay my own gas");
    });

    it("anyone may submit a signed request: the result is the same whoever sends it", async () => {
      const s = await h.signRequest(env, user);
      await env.forwarder.connect(env.signers[3]).execute(s.req, s.signature);
      expect(await env.todo.taskCount(user.address)).to.equal(1n);
    });
  });

  describe("nonce reuse and replay", () => {
    it("the same signed request cannot run twice", async () => {
      const s = await h.signRequest(env, user);
      await exec(s);
      expect(await env.forwarder.verify(s.req, s.signature)).to.equal(false);
      await expect(exec(s)).to.be.revertedWithCustomError(env.forwarder, "BadNonce").withArgs(1n, 0n);
      expect(await env.todo.taskCount(user.address)).to.equal(1n);
    });

    it("nonces are strictly in order: a future nonce is refused until its turn", async () => {
      const later = await h.signRequest(env, user, { nonce: 1n, args: ["second"] });
      await expect(exec(later)).to.be.revertedWithCustomError(env.forwarder, "BadNonce").withArgs(0n, 1n);
      await exec(await h.signRequest(env, user, { nonce: 0n, args: ["first"] }));
      await exec(later);
      expect((await env.todo.getTasks(user.address)).map((t) => t.text)).to.deep.equal(["first", "second"]);
    });

    it("two different requests signed with the same nonce: only one can ever run", async () => {
      const a = await h.signRequest(env, user, { nonce: 0n, args: ["A"] });
      const b = await h.signRequest(env, user, { nonce: 0n, args: ["B"] });
      await exec(b);
      await expect(exec(a)).to.be.revertedWithCustomError(env.forwarder, "BadNonce");
      expect((await env.todo.getTasks(user.address)).map((t) => t.text)).to.deep.equal(["B"]);
    });

    it("a signature for another chain or another forwarder is refused", async () => {
      const otherChain = await h.signRequest(env, user, { chainId: 1 });
      await expect(exec(otherChain)).to.be.revertedWithCustomError(env.forwarder, "BadSignature");
      const fwd2 = await ethers.deployContract("Forwarder");
      const otherFwd = await h.signRequest(env, user, { verifyingContract: await fwd2.getAddress() });
      await expect(exec(otherFwd)).to.be.revertedWithCustomError(env.forwarder, "BadSignature");
    });

    it("a request whose inner call fails does NOT use up the nonce (the user can retry)", async () => {
      const bad = await h.signRequest(env, user, { args: [""] }); // EmptyText
      await expect(exec(bad)).to.be.revertedWithCustomError(env.forwarder, "CallFailed");
      expect(await env.forwarder.nonces(user.address)).to.equal(0n);
    });
  });

  describe("forged and tampered requests", () => {
    it("a request signed by Mallory but claiming to be from the user is refused", async () => {
      const mallory = h.newUser();
      const s = await h.signRequest(env, mallory);
      const forged = { req: { ...s.req, from: user.address }, signature: s.signature };
      await expect(exec(forged)).to.be.revertedWithCustomError(env.forwarder, "BadSignature");
    });

    it("changing any field after signing breaks the signature", async () => {
      const s = await h.signRequest(env, user);
      const evilData = encodeFunctionData({ abi: env.todoInfo.abi, functionName: "addTask", args: ["Send Mallory 1 ETH"] });
      for (const change of [{ data: evilData }, { gas: 199_999n }, { deadline: s.req.deadline + 1 }]) {
        await expect(exec({ req: { ...s.req, ...change }, signature: s.signature })).to.be.revertedWithCustomError(env.forwarder, "BadSignature");
      }
    });

    it("junk and malleable (high-s) signatures are refused without reverting verify()", async () => {
      const s = await h.signRequest(env, user);
      const sig = ethers.Signature.from(s.signature);
      const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
      const highS = ethers.concat([sig.r, ethers.toBeHex(N - BigInt(sig.s), 32), sig.v === 27 ? "0x1c" : "0x1b"]);
      for (const bad of [highS, "0x" + "00".repeat(65), "0x1234"]) {
        expect(await env.forwarder.verify(s.req, bad)).to.equal(false);
        await expect(exec({ req: s.req, signature: bad })).to.be.revertedWithCustomError(env.forwarder, "BadSignature");
      }
    });

    it("an expired request is refused", async () => {
      const s = await h.signRequest(env, user, { deadline: (await h.chainNow()) + 60 });
      await time.increase(61);
      expect(await env.forwarder.verify(s.req, s.signature)).to.equal(false);
      await expect(exec(s)).to.be.revertedWithCustomError(env.forwarder, "Expired");
    });
  });

  describe("sender spoofing (ERC-2771)", () => {
    it("a direct call with the victim's address glued on the end still acts as the caller", async () => {
      const mallory = env.signers[4];
      const data = encodeFunctionData({ abi: env.todoInfo.abi, functionName: "addTask", args: ["spoof"] });
      await mallory.sendTransaction({ to: env.todoInfo.address, data: ethers.concat([data, user.address]) });
      expect(await env.todo.taskCount(user.address)).to.equal(0n);
      expect(await env.todo.taskCount(mallory.address)).to.equal(1n);
    });

    it("the forwarder refuses targets that don't trust it (they would see the forwarder as sender)", async () => {
      const plain = await ethers.deployContract("PlainTarget");
      const data = plain.interface.encodeFunctionData("poke");
      const s = await h.signRequest(env, user, { to: await plain.getAddress(), data });
      expect(await env.forwarder.verify(s.req, s.signature)).to.equal(false);
      await expect(exec(s)).to.be.revertedWithCustomError(env.forwarder, "UntrustfulTarget");
      // an address with no code at all is refused too
      const empty = await h.signRequest(env, user, { to: ethers.Wallet.createRandom().address, data: "0x" });
      await expect(exec(empty)).to.be.revertedWithCustomError(env.forwarder, "UntrustfulTarget");
    });

    it("the to-do list trusts exactly one forwarder, fixed at deploy, and refuses a zero one", async () => {
      expect(await env.todo.trustedForwarder()).to.equal(env.forwarderInfo.address);
      expect(await env.todo.isTrustedForwarder(env.signers[0].address)).to.equal(false);
      const F = await ethers.getContractFactory("GaslessTodoList");
      await expect(F.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(env.todo, "ZeroForwarder");
    });
  });

  describe("relayer must play fair", () => {
    it("the relayer must send exactly the signed value", async () => {
      const s = await h.signRequest(env, user);
      await expect(exec(s, { value: 1n })).to.be.revertedWithCustomError(env.forwarder, "ValueMismatch").withArgs(0n, 1n);
    });

    it("insufficient-gas griefing: an under-funded relay can never count as done", async () => {
      // work() swallows an out-of-gas in heavy(). Try many outer gas limits: every
      // relay that SUCCEEDS must have really done the work.
      const target = await ethers.deployContract("GasGriefTarget", [env.forwarderInfo.address]);
      const to = await target.getAddress();
      const data = target.interface.encodeFunctionData("work");
      const gas = 120_000n;
      let succeeded = 0, refused = 0;
      for (let outer = 100_000; outer <= 300_000; outer += 2_000) {
        const s = await h.signRequest(env, user, { to, data, gas });
        const doneBefore = await target.done();
        try {
          const tx = await exec(s, { gasLimit: outer });
          await tx.wait();
          succeeded++;
          expect(await target.done(), `outer gas ${outer}`).to.equal(doneBefore + 1n);
        } catch (e) {
          if (e.name === "AssertionError") throw e;
          if (process.env.DBG) console.log(outer, (e.shortMessage || e.message).slice(0, 120));
          refused++;
        }
      }
      expect(succeeded).to.be.greaterThan(5);
      expect(refused).to.be.greaterThan(5);
    });
  });

  describe("hostile targets", () => {
    it("a target that returns 200 KB (a 'return bomb') can't make the forwarder pay to copy it", async () => {
      const bomb = await ethers.deployContract("ReturnBomb", [env.forwarderInfo.address]);
      const to = await bomb.getAddress();
      const gas = 250_000n;
      // success with a huge answer: the forwarder ignores it
      const ok = await h.signRequest(env, user, { to, gas, data: bomb.interface.encodeFunctionData("bomb", [200_000, false]) });
      const r1 = await (await exec(ok, { gasLimit: 1_000_000 })).wait();
      // failure with a huge revert reason: only the first 256 bytes are kept
      const bad = await h.signRequest(env, user, { to, gas, data: bomb.interface.encodeFunctionData("bomb", [200_000, true]) });
      const err = await env.forwarder.connect(relayer).execute.staticCall(bad.req, bad.signature, { gasLimit: 1_000_000 }).catch((e) => e);
      const decoded = env.forwarder.interface.parseError(err.data);
      expect(decoded.name).to.equal("CallFailed");
      expect(ethers.getBytes(decoded.args[0]).length).to.equal(256);
      // copying 200 KB would cost the forwarder ~100k gas on top; it pays well under 60k beyond the inner call
      const inner = await ethers.provider.estimateGas({ from: env.forwarderInfo.address, to, data: ok.req.data });
      expect(r1.gasUsed - inner).to.be.lessThan(60_000n);
    });

    it("a target whose isTrustedForwarder() answers with junk (the number 2, or 64 bytes) is not trusted", async () => {
      for (const mode of [0, 1]) {
        const junk = await ethers.deployContract("JunkTrust", [mode]);
        const s = await h.signRequest(env, user, { to: await junk.getAddress(), data: junk.interface.encodeFunctionData("poke") });
        expect(await env.forwarder.verify(s.req, s.signature), `mode ${mode}`).to.equal(false);
        await expect(exec(s)).to.be.revertedWithCustomError(env.forwarder, "UntrustfulTarget");
      }
    });
  });
});
