// Browser test: real Chromium, the real page and server, two real local chains.
const path = require("node:path");
const http = require("node:http");
const { expect } = require("chai");
const { chromium } = require("playwright");
const { startChains } = require("../lib/chains");
const { createApp } = require("../app/server");

describe("Day 26 — the two-chains page in a browser", function () {
  this.timeout(120000);
  let chains, app, base, browser, page;

  before(async () => {
    chains = await startChains({ l1Port: 18845, l2Port: 18846 });
    app = await createApp({ chains, blockMs: 250, pollMs: 150 });
    base = `http://127.0.0.1:${await app.listen(0)}`;
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 760, height: 1100 } })).newPage();
    page.on("dialog", () => { throw new Error("a dialog opened: script injection!"); });
  });
  after(async () => { await browser?.close(); await app?.close(); await chains?.stop(); });

  it("shows both chains and the cost table from the real run", async () => {
    await page.goto(base);
    await page.waitForFunction(() => document.querySelectorAll("#costs tbody tr").length === 3);
    expect(await page.textContent("#l1-id")).to.equal("31337");
    expect(await page.textContent("#l2-id")).to.equal("31338");
  });

  it("sends a task L1 → L2 and L2 → L1; both arrive, shown as plain text", async () => {
    const evil = '<img src=x onerror="alert(1)">';
    await page.fill("#text", evil);
    await page.click("#go");
    await page.waitForFunction(() => document.querySelectorAll("#messages li").length === 1);
    await page.fill("#text", "Book bus to Pokhara");
    await page.selectOption("#direction", "l2-l1");
    await page.click("#go");
    await page.waitForFunction(() => document.querySelectorAll("#messages li.delivered").length === 2, null, { timeout: 20000 });
    expect(await page.locator("#tasks-l2 li").allTextContents()).to.deep.equal(['<img src=x onerror="alert(1)">']);
    expect(await page.locator("#tasks-l1 li").allTextContents()).to.deep.equal(["Book bus to Pokhara"]);
    expect(await page.locator("img").count()).to.equal(0);
    await page.screenshot({ path: path.join(__dirname, "..", "docs", "two-chains-app.png"), fullPage: true });
  });

  it("the server refuses bad input (wrong direction, empty or too long text, not JSON)", async () => {
    const post = (body, type = "application/json") => fetch(base + "/api/send", { method: "POST", headers: { "content-type": type }, body });
    expect((await post(JSON.stringify({ text: "x", direction: "l1-l3" }))).status).to.equal(400);
    expect((await post(JSON.stringify({ text: "  ", direction: "l1-l2" }))).status).to.equal(400);
    expect((await post(JSON.stringify({ text: "x".repeat(281), direction: "l1-l2" }))).status).to.equal(400);
    expect((await post("text=x", "application/x-www-form-urlencoded")).status).to.equal(415);
    expect((await fetch(base + "/../package.json")).status).to.equal(404);
  });

  it("F-3: refuses requests whose Host is not localhost (DNS rebinding)", async () => {
    const status = (host) => new Promise((resolve, reject) => {
      const u = new URL(base);
      http.get({ hostname: u.hostname, port: u.port, path: "/api/state", headers: { Host: host } }, (res) => { res.resume(); resolve(res.statusCode); }).on("error", reject);
    });
    expect(await status("evil.example:" + new URL(base).port)).to.equal(403);
    expect(await status("127.0.0.1:" + new URL(base).port)).to.equal(200);
  });
});
