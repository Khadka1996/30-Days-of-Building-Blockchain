const { expect } = require("chai");
const http = require("node:http");
const { chromium } = require("playwright");
const { ETH, deploy, makeMonitor, mine } = require("./helpers");
const { createDashboard } = require("../monitor/server");

function raw(url, { method = "GET", host } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers: host ? { Host: host } : {} }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("Day 27 — the dashboard in a browser", function () {
  this.timeout(60000);
  let browser;
  before(async () => { browser = await chromium.launch(); });
  after(async () => { await browser.close(); });

  it("shows the vault, the alerts and the guardian's response live", async () => {
    const env = await deploy({ members: 10, each: 10, limit: 60 });
    const m = makeMonitor(env);
    const dash = await createDashboard({ monitor: m, port: 0 });
    const page = await browser.newPage();
    try {
      await mine(2);
      await m.poll();
      await page.goto(dash.url);
      await page.waitForFunction(() => document.getElementById("tvl").textContent === "100 ETH");
      await page.getByText("No alerts yet").waitFor();
      await env.vault.queueDailyLimit(ETH(10000)); // admin key misuse
      for (const u of env.users) await env.vault.connect(u).withdraw(ETH(4)); // a split drain
      await mine(2);
      await m.poll();
      await mine(2);
      await m.poll();
      await page.waitForFunction(() => document.getElementById("paused").textContent === "PAUSED");
      const rows = await page.locator("#alerts tr").evaluateAll((trs) => trs.map((tr) => [...tr.children].slice(0, 2).map((td) => td.textContent).join(" ")));
      expect(rows).to.include.members(["critical UNANNOUNCED_CHANGE", "critical OUTFLOW_SPIKE", "medium WITHDRAWAL_BURST", "high PAUSED", "info ADMIN_CHANGE"]);
      expect(await page.locator("#tvl").textContent()).to.equal("60 ETH");
      expect(await page.locator("#open").textContent()).to.equal("3");
      expect(await page.locator("#pending").textContent()).to.equal("none"); // the bad change was cancelled
      await page.screenshot({ path: "docs/dashboard.png", fullPage: true });
    } finally {
      await page.close();
      await dash.close();
    }
  });

  it("renders alert text as text, never as HTML", async () => {
    const evil = '<img src=x onerror="window.pwned=1">';
    const monitor = { snapshot: () => ({ vault: evil, head: 1, cursor: 1, confirmations: 2, lastError: evil, state: { total: "0", dailyLimit: "1", outToday: "0", day: 0, paused: false, pending: {}, counts: { deposits: 0, withdrawals: 0, admin: 0 } }, alerts: [{ id: "x", rule: evil, severity: "critical", message: evil, response: evil, blockNumber: 1 }] }) };
    const dash = await createDashboard({ monitor, port: 0 });
    const page = await browser.newPage();
    try {
      await page.goto(dash.url);
      await page.locator("td.msg").waitFor();
      expect(await page.locator("td.msg").textContent()).to.equal(evil);
      expect(await page.locator("#alerts img").count()).to.equal(0);
      expect(await page.evaluate(() => window.pwned)).to.equal(undefined);
    } finally {
      await page.close();
      await dash.close();
    }
  });

  it("the server is read-only, only answers for localhost, and serves only its own files", async () => {
    const dash = await createDashboard({ monitor: { snapshot: () => ({}) }, port: 0 });
    try {
      expect(await raw(`${dash.url}/api/state`)).to.equal(200);
      expect(await raw(`${dash.url}/api/state`, { host: "evil.example" })).to.equal(403); // DNS rebinding
      expect(await raw(`${dash.url}/api/state`, { method: "POST" })).to.equal(405);
      expect(await raw(`${dash.url}/..%2f..%2fpackage.json`)).to.equal(404);
      expect(await raw(`${dash.url}/server.js`)).to.equal(404);
    } finally {
      await dash.close();
    }
  });
});
