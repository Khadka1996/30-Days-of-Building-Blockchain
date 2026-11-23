// Sign in with Ethereum: the happy paths, then every replay and phishing trick
// we could think of. Each attack test is named after what the attacker tries.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseSiweMessage } = require("viem/siwe");
const h = require("./helpers");

describe("Day 24 — Sign in with Ethereum server", function () {
  this.timeout(60000);
  let env, app, alice, snap;

  beforeEach(async () => {
    snap = await h.snapshot();
    env = await h.deploy();
    app = await h.startServer(env);
    alice = new h.Browser(app.base);
  });
  afterEach(async () => { await app.close(); await h.revert(snap); });

  describe("happy paths", () => {
    it("signs in a normal wallet and shows its Day 1 tasks", async () => {
      const [me] = env.signers;
      await env.todo.addTask("Buy momo");
      const { res } = await h.signIn(app, alice, me);
      expect(res.status).to.equal(200);
      expect(res.json.address).to.equal(me.address);
      const who = await alice.me();
      expect(who.status).to.equal(200);
      expect(who.json.address).to.equal(me.address);
      expect(who.json.tasks).to.deep.equal([{ id: 1, text: "Buy momo", completed: false }]);
    });

    it("signs in a smart-contract wallet (ERC-1271), signed by its owner key", async () => {
      const owner = env.signers[1];
      const walletAddr = await env.wallet.getAddress();
      const { res } = await h.signIn(app, alice, owner, {}, walletAddr);
      expect(res.status, JSON.stringify(res.json)).to.equal(200);
      expect(res.json.address).to.equal(walletAddr);
    });

    it("refuses a smart wallet signature made by someone who is not the owner", async () => {
      const { res } = await h.signIn(app, alice, env.signers[2], {}, await env.wallet.getAddress());
      expect(res.status).to.equal(401);
      expect(res.json.error).to.contain("signature does not match");
    });

    it("sets HttpOnly + SameSite=Strict cookies and a fresh session id (no fixation)", async () => {
      const { json } = await alice.nonce();
      const pre = alice.jar.siwe_pre; // the pre-login cookie that goes WITH this login
      const message = h.buildMessage(app, env.signers[0].address, json.nonce);
      const res = await alice.login(message, await env.signers[0].signMessage(message));
      expect(res.status).to.equal(200);
      const session = res.setCookies.find((c) => c.startsWith("siwe_session="));
      expect(session).to.match(/HttpOnly/).and.match(/SameSite=Strict/).and.match(/Path=\//);
      expect(alice.jar.siwe_session).to.not.equal(pre);
      expect(alice.jar.siwe_session).to.have.length.greaterThan(40);
      expect(alice.jar.siwe_pre).to.equal(undefined); // pre-login cookie cleared
    });

    it("logout kills the session on the server: a copied cookie stops working", async () => {
      await h.signIn(app, alice, env.signers[0]);
      const stolen = alice.jar.siwe_session;
      expect((await alice.logout()).status).to.equal(200);
      const thief = new h.Browser(app.base);
      thief.jar.siwe_session = stolen;
      expect((await thief.me()).status).to.equal(401);
    });

    it("a session ends at the message's Expiration Time (or after 1 hour, whichever is first)", async () => {
      let now = Date.now();
      app.config.now = () => now;
      const exp = new Date(now + 2 * 60 * 1000);
      await h.signIn(app, alice, env.signers[0], { expirationTime: exp });
      expect((await alice.me()).json.expiresAt).to.equal(exp.toISOString());
      now += 2 * 60 * 1000;
      expect((await alice.me()).status).to.equal(401);
    });
  });

  describe("signature replay", () => {
    it("the same message + signature cannot be used twice", async () => {
      const { message, signature, res } = await h.signIn(app, alice, env.signers[0]);
      expect(res.status).to.equal(200);
      await alice.logout();
      const again = await alice.login(message, signature);
      expect(again.status).to.equal(401);
      expect(again.json.error).to.contain("unknown or used nonce");
    });

    it("a stolen message + signature is useless in the attacker's browser (nonce is tied to the victim's browser)", async () => {
      const { json } = await alice.nonce();
      const message = h.buildMessage(app, env.signers[0].address, json.nonce);
      const signature = await env.signers[0].signMessage(message);
      const mallory = new h.Browser(app.base);
      await mallory.nonce(); // mallory has her own (different) nonce
      const res = await mallory.login(message, signature);
      expect(res.status).to.equal(401);
      expect(res.json.error).to.contain("unknown or used nonce");
      expect((await alice.login(message, signature)).status).to.equal(200); // the real user is not affected
    });

    it("two racing requests with one signature: exactly one wins", async () => {
      const { json } = await alice.nonce();
      const message = h.buildMessage(app, env.signers[0].address, json.nonce);
      const signature = await env.signers[0].signMessage(message);
      const results = await Promise.all(Array.from({ length: 5 }, () => alice.login(message, signature)));
      expect(results.map((r) => r.status).sort()).to.deep.equal([200, 401, 401, 401, 401]);
    });

    it("a failed attempt burns the nonce (no retries with the same nonce)", async () => {
      const { json } = await alice.nonce();
      const message = h.buildMessage(app, env.signers[0].address, json.nonce);
      const wrongSig = await env.signers[3].signMessage(message);
      expect((await alice.login(message, wrongSig)).status).to.equal(401);
      await alice.nonce(); // even with a new pre-login cookie, the old nonce is gone
      const good = await env.signers[0].signMessage(message);
      expect((await alice.login(message, good)).status).to.equal(401);
    });

    it("a nonce expires after 5 minutes", async () => {
      let now = Date.now();
      app.config.now = () => now;
      const { json } = await alice.nonce();
      const message = h.buildMessage(app, env.signers[0].address, json.nonce);
      const signature = await env.signers[0].signMessage(message);
      now += 5 * 60 * 1000 + 1;
      const res = await alice.login(message, signature);
      expect(res.status).to.equal(401);
      expect(res.json.error).to.contain("nonce");
    });

    it("an expired message, a message from the future, or an old message is refused", async () => {
      const now = Date.now();
      const cases = [
        [{ expirationTime: new Date(now - 1000), issuedAt: new Date(now - 60000) }, "expired"],
        [{ issuedAt: new Date(now + 10 * 60 * 1000), expirationTime: new Date(now + 20 * 60 * 1000) }, "future"],
        [{ issuedAt: new Date(now - 6 * 60 * 1000), expirationTime: new Date(now + 60000) }, "too old"],
        [{ notBefore: new Date(now + 10 * 60 * 1000) }, "not yet valid"],
      ];
      for (const [over, reason] of cases) {
        const { res } = await h.signIn(app, new h.Browser(app.base), env.signers[0], over);
        expect(res.status, reason).to.equal(401);
        expect(res.json.error).to.contain(reason);
      }
    });

    it("a message for another chain is refused", async () => {
      const { res } = await h.signIn(app, alice, env.signers[0], { chainId: 1 });
      expect(res.status).to.equal(401);
      expect(res.json.error).to.contain("wrong chain ID");
    });
  });

  describe("phishing", () => {
    it("a signature collected by a phishing site (its own domain) cannot log in here", async () => {
      // The user signed on evil.example; the attacker replays it against us with a real nonce.
      const { res } = await h.signIn(app, alice, env.signers[0], { domain: "evil.example", uri: "https://evil.example" });
      expect(res.status).to.equal(401);
      expect(res.json.error).to.contain("wrong domain: evil.example");
    });

    it("a look-alike domain or a port change is a different site", async () => {
      const port = new URL(app.base).port;
      for (const domain of [`localhost:${port}`, `127.0.0.1:${Number(port) + 1}`, "127.0.0.1"]) {
        const { res } = await h.signIn(app, new h.Browser(app.base), env.signers[0], { domain });
        expect(res.status, domain).to.equal(401);
      }
    });

    it("our domain but a URI on another site is refused", async () => {
      const { res } = await h.signIn(app, alice, env.signers[0], { uri: "https://evil.example/login" });
      expect(res.status).to.equal(401);
      expect(res.json.error).to.contain("wrong URI");
    });

    it("login requests from another site are refused (login CSRF): wrong or missing Origin", async () => {
      const { json } = await alice.nonce();
      const message = h.buildMessage(app, env.signers[0].address, json.nonce);
      const signature = await env.signers[0].signMessage(message);
      expect((await alice.login(message, signature, { headers: { origin: "https://evil.example" } })).status).to.equal(403);
      const noOrigin = await alice.req("/api/login", { method: "POST", body: { message, signature }, headers: { origin: undefined } });
      expect(noOrigin.status).to.equal(403);
      const form = await alice.req("/api/login", { method: "POST", raw: "message=x", headers: { "content-type": "application/x-www-form-urlencoded" } });
      expect(form.status).to.equal(415);
    });
  });

  describe("tampered or malformed messages", () => {
    it("someone else's key cannot sign in as you", async () => {
      const { json } = await alice.nonce();
      const message = h.buildMessage(app, env.signers[0].address, json.nonce);
      const res = await alice.login(message, await env.signers[4].signMessage(message));
      expect(res.status).to.equal(401);
      expect(res.json.error).to.contain("signature does not match");
    });

    it("a smuggled second 'Nonce:' line is refused (viem's parser alone would ignore it)", async () => {
      const { json } = await alice.nonce();
      const message = h.buildMessage(app, env.signers[0].address, json.nonce) + "\nNonce: aaaaaaaaaaaaaaaa";
      expect(parseSiweMessage(message).nonce).to.equal(json.nonce); // lenient parser: extra line silently dropped
      const res = await alice.login(message, await env.signers[0].signMessage(message));
      expect(res.status).to.equal(401);
      expect(res.json.error).to.contain("exact EIP-4361 form");
    });

    it("a lower-case (non-checksummed) address is refused", async () => {
      // viem's createSiweMessage always checksums, so write the lower-case text by hand (as another library might).
      const { json } = await alice.nonce();
      const addr = env.signers[0].address;
      const message = h.buildMessage(app, addr, json.nonce).replace(addr, addr.toLowerCase());
      const res = await alice.login(message, await env.signers[0].signMessage(message));
      expect(res.status).to.equal(401);
      expect(res.json.error).to.contain("checksummed");
    });

    it("rejects junk input without crashing", async () => {
      await alice.nonce();
      const bad = [
        { message: 42, signature: "0x00" },
        { message: "hello", signature: "0x" + "11".repeat(65) },
        { message: "x".repeat(2001), signature: "0x" + "11".repeat(65) },
        { message: "hello", signature: "not-hex" },
        {},
      ];
      for (const body of bad) {
        await alice.nonce();
        const res = await alice.req("/api/login", { method: "POST", body });
        expect(res.status, JSON.stringify(body).slice(0, 40)).to.equal(401);
      }
      expect((await alice.req("/api/login", { method: "POST", raw: "{oops", headers: { "content-type": "application/json" } })).status).to.equal(400);
      expect((await alice.req("/api/login", { method: "POST", raw: JSON.stringify({ message: "a".repeat(9000) }), headers: { "content-type": "application/json" } })).status).to.equal(413);
    });

    it("a valid signature over a garbled message is refused", async () => {
      const { json } = await alice.nonce();
      const good = h.buildMessage(app, env.signers[0].address, json.nonce);
      const sig = await env.signers[0].signMessage(good);
      const res = await alice.login(good.replace("Sign in", "Sign  in"), sig);
      expect(res.status).to.equal(401);
    });
  });

  describe("server hygiene", () => {
    it("caps unused nonces (memory DoS) and recovers when they expire", async () => {
      await app.close();
      let now = Date.now();
      app = await h.startServer(env, { maxPending: 3, now: () => now });
      const b = new h.Browser(app.base);
      for (let i = 0; i < 3; i++) expect((await b.nonce()).status).to.equal(200);
      expect((await b.nonce()).status).to.equal(503);
      now += 5 * 60 * 1000 + 1;
      expect((await b.nonce()).status).to.equal(200);
    });

    it("one address can hold at most 5 sessions: a 6th login ends the oldest (memory DoS)", async () => {
      const browsers = [];
      for (let i = 0; i < 6; i++) {
        const b = new h.Browser(app.base);
        expect((await h.signIn(app, b, env.signers[0])).res.status).to.equal(200);
        browsers.push(b);
      }
      expect([...app.sessions.values()].filter((s) => s.address === env.signers[0].address)).to.have.length(5);
      expect((await browsers[0].me()).status).to.equal(401); // oldest pushed out
      expect((await browsers[5].me()).status).to.equal(200);
    });

    it("nonces are random, 32 hex chars, never repeated", async () => {
      const seen = new Set();
      for (let i = 0; i < 50; i++) {
        const { json } = await new h.Browser(app.base).nonce();
        expect(json.nonce).to.match(/^[0-9a-f]{32}$/);
        seen.add(json.nonce);
      }
      expect(seen.size).to.equal(50);
    });

    it("serves only its own files, with security headers", async () => {
      const page = await fetch(app.base + "/");
      expect(page.status).to.equal(200);
      expect(page.headers.get("content-security-policy")).to.contain("script-src 'self'").and.contain("frame-ancestors 'none'");
      expect(page.headers.get("x-content-type-options")).to.equal("nosniff");
      for (const p of ["/../package.json", "/auth/server.js", "/%2e%2e/package.json", "/deployments.json"]) {
        expect((await fetch(app.base + p)).status, p).to.equal(404);
      }
      expect((await fetch(app.base + "/api/me", { method: "POST" })).status).to.equal(405);
      expect(page.headers.get("access-control-allow-origin")).to.equal(null);
    });

    it("/api/me without a cookie, or with a made-up one, is 401", async () => {
      expect((await alice.me()).status).to.equal(401);
      alice.jar.siwe_session = "made-up";
      expect((await alice.me()).status).to.equal(401);
      alice.jar = {};
      await alice.nonce();
      alice.jar.siwe_session = alice.jar.siwe_pre; // a pre-login cookie is not a session
      expect((await alice.me()).status).to.equal(401);
    });

    it("works with ethers' checksum addresses from every Hardhat account", async () => {
      for (const s of env.signers.slice(0, 5)) {
        const b = new h.Browser(app.base);
        expect((await h.signIn(app, b, s)).res.status).to.equal(200);
        expect((await b.me()).json.address).to.equal(ethers.getAddress(s.address));
      }
    });
  });
});
