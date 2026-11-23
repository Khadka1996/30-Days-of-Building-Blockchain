// Browser tests: real Chromium, the real page and server, the in-process chain,
// and a fake wallet (window.ethereum) whose keys stay in Node.
const http = require("node:http");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { chromium } = require("playwright");
const h = require("./helpers");

describe("Day 24 — sign-in page in the browser", function () {
  this.timeout(120000);
  let env, app, snap, browser, ctx, page, wallet, alerts;

  before(async () => { browser = await chromium.launch(); });
  after(async () => { await browser?.close(); });

  /** Install a fake EIP-1193 wallet. `wallet` controls how it answers. */
  async function newPage() {
    const p = await ctx.newPage();
    await p.exposeFunction("__wallet", async (method, params) => {
      wallet.calls.push(method);
      if (method === "eth_requestAccounts") return [wallet.signer.address.toLowerCase()]; // like MetaMask: lower case
      if (method === "eth_chainId") return "0x" + wallet.chainId.toString(16);
      if (method === "personal_sign") {
        if (wallet.reject) return { error: { code: 4001, message: "User rejected the request." } };
        const text = ethers.toUtf8String(params[0]);
        wallet.signed.push(text);
        return wallet.signer.signMessage(text);
      }
      return { error: { code: 4200, message: "unsupported" } };
    });
    await p.addInitScript(() => {
      window.ethereum = {
        async request({ method, params }) {
          const r = await window.__wallet(method, params);
          if (r && r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
          return r;
        },
      };
    });
    p.on("dialog", async (d) => { alerts.push(d.message()); await d.dismiss(); });
    return p;
  }

  beforeEach(async () => {
    snap = await h.snapshot();
    env = await h.deploy();
    app = await h.startServer(env);
    wallet = { signer: env.signers[0], chainId: h.CHAIN_ID, reject: false, calls: [], signed: [] };
    alerts = [];
    ctx = await browser.newContext();
    page = await newPage();
  });
  afterEach(async () => { await ctx?.close(); await app.close(); await h.revert(snap); });

  it("signs in with the wallet, shows the user's tasks, signs out", async () => {
    await env.todo.addTask("Buy momo for the team");
    await page.goto(app.base);
    await page.click("#login");
    await page.locator("#signed-in").waitFor({ state: "visible" });
    expect(await page.textContent("#who")).to.equal(env.signers[0].address); // checksummed, though the wallet gave lower case
    expect(await page.locator("#tasks li").allTextContents()).to.deep.equal(["○ #1 Buy momo for the team"]);

    // The text the user saw in the wallet names this exact site and a one-time nonce.
    const signed = wallet.signed[0];
    expect(signed.split("\n")[0]).to.equal(`${new URL(app.base).host} wants you to sign in with your Ethereum account:`);
    expect(signed).to.contain(`URI: ${app.base}`).and.contain("Chain ID: 31337").and.match(/Nonce: [0-9a-f]{32}/);

    await page.reload();
    await page.locator("#signed-in").waitFor({ state: "visible" }); // the session survives a reload
    await page.click("#logout");
    await page.locator("#signed-out").waitFor({ state: "visible" });
    await page.reload();
    await page.locator("#signed-out").waitFor({ state: "visible" });
  });

  it("the session cookie can't be read by page scripts (HttpOnly)", async () => {
    await page.goto(app.base);
    await page.click("#login");
    await page.locator("#signed-in").waitFor({ state: "visible" });
    expect(await page.evaluate(() => document.cookie)).to.equal("");
  });

  it("a rejected signature shows a clear message and signs nobody in", async () => {
    wallet.reject = true;
    await page.goto(app.base);
    await page.click("#login");
    await page.waitForFunction(() => document.getElementById("status").textContent.includes("cancelled"));
    expect(await page.locator("#signed-out").isVisible()).to.equal(true);
    expect((await page.request.get(app.base + "/api/me")).status()).to.equal(401);
  });

  it("a wallet on the wrong chain is told to switch, and is never asked to sign", async () => {
    wallet.chainId = 1;
    await page.goto(app.base);
    await page.click("#login");
    await page.waitForFunction(() => document.getElementById("status").textContent.includes("Switch it to chain 31337"));
    expect(wallet.calls).to.not.include("personal_sign");
  });

  it("task text with HTML is shown as text, never run", async () => {
    await env.todo.addTask(`<img src=x onerror="alert('xss')">`);
    await page.goto(app.base);
    await page.click("#login");
    await page.locator("#signed-in").waitFor({ state: "visible" });
    expect(await page.locator("#tasks img").count()).to.equal(0);
    expect(await page.textContent("#tasks li")).to.contain("<img src=x");
    expect(alerts).to.deep.equal([]);
  });

  it("another site can't use the user's session: no cookie sent, no data read, logout refused", async () => {
    await page.goto(app.base);
    await page.click("#login");
    await page.locator("#signed-in").waitFor({ state: "visible" });

    // evil site on a different origin (localhost ≠ 127.0.0.1) in the same browser
    const evil = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<h1>Free airdrop!</h1>"); });
    await new Promise((r) => evil.listen(0, "localhost", r));
    const seen = [];
    app.server.on("request", (req) => seen.push({ url: req.url, cookie: req.headers.cookie || "" }));
    const evilPage = await ctx.newPage();
    await evilPage.goto(`http://localhost:${evil.address().port}/`);
    const result = await evilPage.evaluate(async (base) => {
      const out = {};
      try { out.me = await (await fetch(base + "/api/me", { credentials: "include" })).text(); } catch (e) { out.me = "blocked: " + e.name; }
      try { await fetch(base + "/api/logout", { method: "POST", credentials: "include", mode: "no-cors", headers: { "Content-Type": "text/plain" }, body: "{}" }); } catch {}
      return out;
    }, app.base);
    await evilPage.close();
    await new Promise((r) => evil.close(r));

    expect(seen.map((s) => s.url)).to.include.members(["/api/me", "/api/logout"]); // the requests really reached us
    expect(result.me).to.match(/^blocked/); // no CORS header → the evil page can't read the answer
    expect(seen.filter((s) => s.url.startsWith("/api/")).every((s) => !s.cookie.includes("siwe_session"))).to.equal(true); // SameSite=Strict
    expect((await page.request.get(app.base + "/api/me")).status()).to.equal(200); // still signed in
  });
});
