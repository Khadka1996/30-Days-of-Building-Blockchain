// Browser tests for the live feed: a real Chromium, the real feed server, the
// in-process Hardhat chain. Run with the rest: `npm test`.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { chromium } = require("playwright");
const { createFeedServer } = require("../indexer/server");
const h = require("./helpers");

describe("Day 23 — live feed in the browser", function () {
  this.timeout(120000);
  let env, snap, feed, browser, page, base, alerts;

  before(async () => { browser = await chromium.launch(); });
  after(async () => { await browser?.close(); });

  beforeEach(async () => {
    snap = await h.snapshot();
    env = await h.deploy();
    const indexer = h.makeIndexer(env.contracts, { confirmations: 3 });
    feed = createFeedServer({ indexer, pollMs: 200 });
    const port = await feed.listen(0);
    base = `http://127.0.0.1:${port}`;
    page = await browser.newPage();
    alerts = [];
    page.on("dialog", async (d) => { alerts.push(d.message()); await d.dismiss(); });
  });
  afterEach(async () => { await page?.close(); await feed?.close(); await h.revert(snap); });

  const items = () => page.locator("#feed li");

  it("shows new activity live, pending first, then confirmed", async () => {
    await page.goto(base);
    expect(await page.locator("#empty").isVisible()).to.equal(true);

    await env.todo.addTask("Pay electricity bill");
    await items().first().waitFor();
    expect(await items().first().locator(".what").textContent()).to.contain("added task #1: “Pay electricity bill”");
    expect(await items().first().locator(".badge").textContent()).to.equal("pending 1/3");

    const now = (await ethers.provider.getBlock("latest")).timestamp;
    await env.bank.deposit(now + 86400 * 30, { value: ethers.parseEther("1.5") });
    await page.waitForFunction(() => document.querySelectorAll("#feed li").length === 2);
    expect(await items().first().locator(".what").textContent()).to.match(/locked 1\.5 ETH until \d{4}-\d\d-\d\d \(now 1\.5 ETH\)/);

    await h.mine(2);
    await page.waitForFunction(() => document.querySelector("#feed li:last-child .badge").textContent === "confirmed");
  });

  it("shows a reorg: orphaned events disappear and are listed as removed", async () => {
    await env.todo.addTask("safe");
    await page.goto(base);
    await items().first().waitFor();

    const fork = await h.snapshot();
    await env.todo.connect(env.signers[1]).addTask("This task will vanish in a reorg");
    await page.waitForFunction(() => document.querySelectorAll("#feed li").length === 2);

    await h.revert(fork);
    await ethers.provider.send("evm_increaseTime", [15]);
    await env.todo.connect(env.signers[2]).addTask("Written on the winning branch");
    await h.mine(2);

    await page.locator("#reorg").waitFor({ state: "visible" });
    expect(await page.locator("#reorg").textContent()).to.contain("1 event(s) removed");
    expect(await page.locator("#reorg s").textContent()).to.contain("This task will vanish");
    await page.waitForFunction(() => [...document.querySelectorAll("#feed .what")].some((e) => e.textContent.includes("winning branch")));
    const texts = await page.locator("#feed .what").allTextContents();
    expect(texts.join("|")).to.not.contain("vanish");
    expect(texts).to.have.length(2);
  });

  it("task text is shown as text: HTML/JS in an event never runs", async () => {
    const payloads = [`<img src=x onerror="alert('xss')">`, `<script>alert(1)</script>`, `"><svg onload=alert(2)>`];
    for (const p of payloads) await env.todo.addTask(p);
    await page.goto(base);
    await page.waitForFunction(() => document.querySelectorAll("#feed li").length === 3);
    await page.waitForTimeout(500);
    expect(alerts).to.deep.equal([]);
    expect(await page.locator("#feed img, #feed script, #feed svg").count()).to.equal(0);
    const texts = (await page.locator("#feed .what").allTextContents()).join("|");
    for (const p of payloads) expect(texts).to.contain(p);
  });

  it("says so when the chain is unreachable, and keeps the last good data", async () => {
    await env.todo.addTask("still here");
    await page.goto(base);
    await items().first().waitFor();
    // the RPC goes down: every sync now fails
    const realSync = feed.indexer.sync.bind(feed.indexer);
    feed.indexer.sync = async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:8545"); };
    await page.locator("#error").waitFor({ state: "visible" });
    expect(await page.locator("#error").textContent()).to.contain("ECONNREFUSED");
    expect(await items().count()).to.equal(1);
    feed.indexer.sync = realSync;
    await page.locator("#error").waitFor({ state: "hidden" });
  });

  it("starts even when the chain is down, and reports it instead of crashing", async () => {
    // An RPC URL with an API key in it (like Infura/Alchemy) on a port nobody listens on.
    const { createPublicClient, http } = require("viem");
    const down = createPublicClient({ transport: http("http://127.0.0.1:9/v3/SECRET-API-KEY", { retryCount: 0 }) });
    const offline = createFeedServer({ indexer: h.makeIndexer(env.contracts, { client: down }), pollMs: 200 });
    let port;
    try {
      port = await offline.listen(0);
      const body = await (await fetch(`http://127.0.0.1:${port}/api/feed`)).json();
      expect(body.status.error).to.equal("HTTP request failed.");
      expect(JSON.stringify(body)).to.not.contain("SECRET-API-KEY"); // the RPC URL never reaches the browser
      expect(body.events).to.deep.equal([]);
    } finally { if (port) await offline.close(); }
  });

  it("serves only its own files, with strict security headers", async () => {
    const res = await fetch(base + "/");
    const csp = res.headers.get("content-security-policy");
    expect(csp).to.contain("default-src 'none'").and.contain("script-src 'self'").and.contain("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).to.equal("DENY");
    expect(res.headers.get("x-content-type-options")).to.equal("nosniff");
    expect(res.headers.get("access-control-allow-origin")).to.equal(null); // other sites can't read the feed
    for (const p of ["/../package.json", "/%2e%2e/package.json", "/indexer/server.js", "/data/index.json"]) {
      expect((await fetch(base + p)).status, p).to.equal(404);
    }
    expect((await fetch(base + "/api/feed", { method: "POST" })).status).to.equal(405);
  });
});

