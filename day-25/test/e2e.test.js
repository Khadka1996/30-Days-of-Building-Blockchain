// Browser tests: real Chromium, the real page and relayer, the in-process chain,
// and a fake wallet (window.ethereum) whose key stays in Node and holds 0 ETH.
const path = require("node:path");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { chromium } = require("playwright");
const h = require("./helpers");

describe("Day 25 — gasless page in the browser", function () {
  this.timeout(120000);
  let env, app, snap, browser, ctx, page, wallet, dialogs;

  before(async () => { browser = await chromium.launch(); });
  after(async () => { await browser?.close(); });

  beforeEach(async () => {
    snap = await h.snapshot();
    env = await h.deploy();
    app = await h.startRelayer(env);
    wallet = { signer: h.newUser(), chainId: h.CHAIN_ID, reject: false, calls: [] };
    dialogs = [];
    ctx = await browser.newContext({ viewport: { width: 760, height: 640 } });
    page = await ctx.newPage();
    await page.exposeFunction("__wallet", async (method, params) => {
      wallet.calls.push(method);
      if (method === "eth_requestAccounts") return [wallet.signer.address.toLowerCase()]; // like MetaMask
      if (method === "eth_chainId") return "0x" + wallet.chainId.toString(16);
      if (method === "eth_signTypedData_v4") {
        if (wallet.reject) return { error: { code: 4001, message: "User rejected the request." } };
        const td = JSON.parse(params[1]);
        const { EIP712Domain, ...types } = td.types; // ethers adds the domain type itself
        return wallet.signer.signTypedData(td.domain, types, td.message);
      }
      return { error: { code: 4200, message: "unsupported" } };
    });
    await page.addInitScript(() => {
      window.ethereum = {
        async request({ method, params }) {
          const r = await window.__wallet(method, params);
          if (r && r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
          return r;
        },
      };
    });
    page.on("dialog", async (d) => { dialogs.push(d.message()); await d.dismiss(); });
  });
  afterEach(async () => { await ctx?.close(); await app.close(); await h.revert(snap); });

  async function connect() {
    await page.goto(app.base);
    await page.click("#connect");
    await page.locator("#app").waitFor({ state: "visible" });
  }
  async function addTask(text) {
    await page.fill("#text", text);
    await page.click("#add button");
    await page.waitForFunction(() => /done in block|Refused|cancelled|Wrong network/.test(document.getElementById("status").textContent));
  }

  it("adds, completes and deletes tasks with a 0-ETH wallet: the relayer pays", async () => {
    await connect();
    expect(await page.textContent("#who")).to.equal(wallet.signer.address); // checksummed
    expect(await page.textContent("#balance")).to.equal("0");

    await addTask("Pay electricity bill");
    expect(await page.textContent("#status")).to.match(/Added: done in block \d+\. The relayer paid \d+ gas, you paid 0\./);
    await addTask("Buy momo for the team");
    await page.locator("#tasks li").nth(0).locator("text=Done").click();
    await page.waitForFunction(() => /Completed: done/.test(document.getElementById("status").textContent));
    await page.locator("#tasks li.done").waitFor();
    await page.screenshot({ path: path.join(__dirname, "..", "docs", "gasless-app.png") });

    await page.locator("#tasks li").nth(1).locator("text=Delete").click();
    await page.waitForFunction(() => /Deleted: done/.test(document.getElementById("status").textContent));

    const tasks = await env.todo.getTasks(wallet.signer.address);
    expect(tasks.map((t) => [t.text, t.completed])).to.deep.equal([["Pay electricity bill", true]]);
    expect(await ethers.provider.getBalance(wallet.signer.address)).to.equal(0n);
    expect(await page.textContent("#nonce")).to.equal("4");
    expect(wallet.calls.filter((c) => c === "eth_signTypedData_v4").length).to.equal(4);
  });

  it("a cancelled signature sends nothing", async () => {
    await connect();
    wallet.reject = true;
    const before = await h.txCount(app.relayerAddress);
    await addTask("never");
    expect(await page.textContent("#status")).to.equal("You cancelled the signature. Nothing was sent.");
    expect(await h.txCount(app.relayerAddress)).to.equal(before);
  });

  it("on the wrong network the wallet is never asked to sign", async () => {
    await connect();
    wallet.chainId = 1;
    await addTask("wrong chain");
    expect(await page.textContent("#status")).to.match(/Wrong network \(chain 1\)/);
    expect(wallet.calls).to.not.include("eth_signTypedData_v4");
  });

  it("task text is shown as text, never run as code (XSS)", async () => {
    await connect();
    await addTask('<img src=x onerror="alert(1)">');
    await page.locator("#tasks li").first().waitFor();
    expect(await page.locator("#tasks li span").first().textContent()).to.equal('<img src=x onerror="alert(1)">');
    expect(await page.locator("#tasks img").count()).to.equal(0);
    expect(dialogs).to.deep.equal([]);
  });
});
