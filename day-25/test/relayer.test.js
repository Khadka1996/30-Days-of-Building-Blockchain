// Relayer tests over real HTTP. The relayer's wallet pays the gas, so the key
// question for every attack: did the relayer send a transaction (and pay) for it?
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { encodeFunctionData } = require("viem");
const h = require("./helpers");

describe("Day 25 — relayer server", function () {
  this.timeout(60000);
  let env, app, user, snap;

  beforeEach(async () => {
    snap = await h.snapshot();
    env = await h.deploy();
    app = await h.startRelayer(env);
    user = h.newUser();
  });
  afterEach(async () => { await app.close(); await h.revert(snap); });

  /** Run `fn`; return how many transactions the relayer sent meanwhile. */
  async function relayerTxs(fn) {
    const before = await h.txCount(app.relayerAddress);
    await fn();
    return (await h.txCount(app.relayerAddress)) - before;
  }

  describe("happy path", () => {
    it("relays a signed addTask for a user with 0 ETH and returns the tx", async () => {
      const s = await h.signRequest(env, user, { args: ["Pay electricity bill"] });
      const r = await app.post(h.toJson(s));
      expect(r.status, JSON.stringify(r.body)).to.equal(200);
      expect(r.body.hash).to.match(/^0x[0-9a-f]{64}$/);
      expect(Number(r.body.gasUsed)).to.be.greaterThan(50_000);
      expect((await env.todo.getTasks(user.address))[0].text).to.equal("Pay electricity bill");
      expect(await ethers.provider.getBalance(user.address)).to.equal(0n);
      const tx = await ethers.provider.getTransaction(r.body.hash);
      expect(tx.from).to.equal(app.relayerAddress);
    });

    it("serves config and account state for the page", async () => {
      const cfg = await (await fetch(`${app.base}/api/config`)).json();
      expect(cfg).to.include({ chainId: 31337, forwarder: env.forwarderInfo.address, todo: env.todoInfo.address });
      await app.post(h.toJson(await h.signRequest(env, user, { args: ["x"] })));
      const acc = await (await fetch(`${app.base}/api/account/${user.address.toLowerCase()}`)).json();
      expect(acc).to.deep.include({ address: user.address, nonce: "1", balance: "0" });
      expect(acc.tasks).to.deep.equal([{ id: "1", completed: false, text: "x" }]);
    });
  });

  describe("nonce reuse", () => {
    it("the same signed request relayed twice: second is refused BEFORE sending", async () => {
      const s = await h.signRequest(env, user);
      expect((await app.post(h.toJson(s))).status).to.equal(200);
      const sent = await relayerTxs(async () => {
        const r = await app.post(h.toJson(s));
        expect(r.status).to.equal(400);
        expect(r.body.error).to.match(/nonce already used/);
      });
      expect(sent).to.equal(0);
    });

    it("5 copies sent at the same moment: exactly one is relayed, one transaction is paid", async () => {
      const s = await h.signRequest(env, user);
      let results;
      const sent = await relayerTxs(async () => {
        results = await Promise.all(Array.from({ length: 5 }, () => app.post(h.toJson(s))));
      });
      expect(results.filter((r) => r.status === 200).length).to.equal(1);
      expect(results.filter((r) => r.status === 409 || r.status === 400).length).to.equal(4);
      expect(sent).to.equal(1);
      expect(await env.todo.taskCount(user.address)).to.equal(1n);
    });

    it("a request with a future nonce is refused without paying (it would fail on-chain)", async () => {
      const s = await h.signRequest(env, user, { nonce: 3n });
      const sent = await relayerTxs(async () => { expect((await app.post(h.toJson(s))).status).to.equal(400); });
      expect(sent).to.equal(0);
    });
  });

  describe("relayer abuse: nothing the relayer refuses costs it gas", () => {
    it("a request that would revert (empty task) is caught by simulation, not paid for", async () => {
      const s = await h.signRequest(env, user, { args: [""] });
      const sent = await relayerTxs(async () => {
        const r = await app.post(h.toJson(s));
        expect(r.status).to.equal(400);
        expect(r.body.error).to.equal("would fail on-chain: EmptyText");
      });
      expect(sent).to.equal(0);
    });

    it("forged signature (Mallory signs, claims to be the user) → 401, no tx", async () => {
      const mallory = h.newUser();
      const s = await h.signRequest(env, mallory);
      const forged = h.toJson({ req: { ...s.req, from: user.address }, signature: s.signature });
      const sent = await relayerTxs(async () => { expect((await app.post(forged)).status).to.equal(401); });
      expect(sent).to.equal(0);
    });

    it("only pays for OUR to-do contract: another app that trusts the same forwarder is refused", async () => {
      const s = await h.signRequest(env, user, { to: await env.otherApp.getAddress() });
      const r = await app.post(h.toJson(s));
      expect(r.status).to.equal(403);
      expect(r.body.error).to.match(/only pays for the to-do contract/);
    });

    it("only the 3 write functions: a read-only call is refused", async () => {
      const data = encodeFunctionData({ abi: env.todoInfo.abi, functionName: "taskCount", args: [user.address] });
      const r = await app.post(h.toJson(await h.signRequest(env, user, { data })));
      expect(r.status).to.equal(403);
      const empty = await app.post(h.toJson(await h.signRequest(env, user, { data: "0x" })));
      expect(empty.status).to.equal(403);
    });

    it("never sends ETH for the user (value > 0 refused)", async () => {
      const r = await app.post(h.toJson(await h.signRequest(env, user, { value: 1n })));
      expect(r.status).to.equal(403);
      expect(r.body.error).to.match(/value must be 0/);
    });

    it("refuses a gas request above the cap", async () => {
      const r = await app.post(h.toJson(await h.signRequest(env, user, { gas: 10_000_000n })));
      expect(r.status).to.equal(403);
      expect(r.body.error).to.match(/gas must be at most 300000/);
    });

    it("refuses a deadline more than 1 hour away (a long-lived signature is a time bomb) and an expired one", async () => {
      const far = await app.post(h.toJson(await h.signRequest(env, user, { deadline: (await h.chainNow()) + 365 * 86400 })));
      expect(far.status).to.equal(403);
      const old = await app.post(h.toJson(await h.signRequest(env, user, { deadline: (await h.chainNow()) - 1 })));
      expect(old.status).to.equal(400);
      expect(old.body.error).to.equal("request expired");
    });

    it("rate limit: 10 relays per signer per minute, the 11th gets 429; other users are not affected", async () => {
      for (let i = 0; i < 10; i++) {
        const r = await app.post(h.toJson(await h.signRequest(env, user, { args: [`task ${i}`] })));
        expect(r.status, r.body.error).to.equal(200);
      }
      const eleventh = await app.post(h.toJson(await h.signRequest(env, user, { args: ["one too many"] })));
      expect(eleventh.status).to.equal(429);
      const other = await app.post(h.toJson(await h.signRequest(env, h.newUser())));
      expect(other.status).to.equal(200);
    });

    it("forged requests can't use up a victim's rate limit", async () => {
      const mallory = h.newUser();
      for (let i = 0; i < 15; i++) {
        const s = await h.signRequest(env, mallory, { args: [`spam ${i}`] });
        const r = await app.post(h.toJson({ req: { ...s.req, from: user.address }, signature: s.signature }));
        expect(r.status).to.equal(401);
      }
      const real = await app.post(h.toJson(await h.signRequest(env, user)));
      expect(real.status).to.equal(200);
    });

    it("rejects junk input without crashing", async () => {
      const s = h.toJson(await h.signRequest(env, user));
      const cases = [
        ["not json", 400], [JSON.stringify([]), 400], [JSON.stringify({}), 400],
        [JSON.stringify({ ...s, signature: "0x12" }), 400],
        [JSON.stringify({ ...s, request: { ...s.request, extra: 1 } }), 400],
        [JSON.stringify({ ...s, request: { ...s.request, gas: 200000 } }), 400],      // number, not string
        [JSON.stringify({ ...s, request: { ...s.request, nonce: "-1" } }), 400],
        [JSON.stringify({ ...s, request: { ...s.request, nonce: "007" } }), 400],
        [JSON.stringify({ ...s, request: { ...s.request, from: "0x123" } }), 400],
        [JSON.stringify({ ...s, request: { ...s.request, data: "0xzz" } }), 400],
        [JSON.stringify({ ...s, request: { ...s.request, data: "0x" + "ab".repeat(2000) } }), 400],
        [JSON.stringify({ ...s, request: { ...s.request, deadline: "99999999999999999999" } }), 400],
        ["x".repeat(20000), 413],
      ];
      for (const [body, status] of cases) {
        const r = await app.post(body);
        expect(r.status, body.slice(0, 80)).to.equal(status);
      }
      const wrongType = await fetch(`${app.base}/api/relay`, { method: "POST", body: JSON.stringify(s), headers: { "content-type": "text/plain" } });
      expect(wrongType.status).to.equal(415);
      expect((await app.post(s)).status).to.equal(200); // and it still works
    });

    it("refuses new work when the queue is full", async () => {
      await app.close();
      app = await h.startRelayer(env, { limits: { maxQueue: 1 } });
      const users = [h.newUser(), h.newUser(), h.newUser()];
      const reqs = await Promise.all(users.map((u) => h.signRequest(env, u)));
      const results = await Promise.all(reqs.map((s) => app.post(h.toJson(s))));
      expect(results.map((r) => r.status)).to.include(503);
      expect(results.map((r) => r.status)).to.include(200);
    });

    it("serves only its 3 static files (no path tricks)", async () => {
      for (const p of ["/", "/app.js", "/style.css"]) expect((await fetch(app.base + p)).status).to.equal(200);
      for (const p of ["/../package.json", "/%2e%2e/package.json", "/relayer/server.js", "/index.html/", "/api/account/0x123"]) {
        expect((await fetch(app.base + p)).status, p).to.be.oneOf([400, 404]);
      }
      const res = await fetch(app.base + "/");
      expect(res.headers.get("content-security-policy")).to.include("script-src 'self'");
    });
  });
});
