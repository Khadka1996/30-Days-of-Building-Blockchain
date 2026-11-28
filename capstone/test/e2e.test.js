// Day 29 — end-to-end: the real web app in Chromium (Playwright) against a real JSON-RPC node.
// An institution uploads a CSV, backs up, publishes with its wallet and downloads the pack;
// a verifier scans the QR image or opens the link and gets the answer from the chain.
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { expect } = require("chai");
const { ethers, network, run } = require("hardhat");
const { TASK_NODE_CREATE_SERVER } = require("hardhat/builtin-tasks/task-names");
const { chromium } = require("playwright");
const { buildBatch } = require("../lib/pramaan");
const { build } = require("../app/build");
const { createAppServer } = require("../app/server");
const C = require("../app/src/codec");
const { cert, deployFixture } = require("./helpers");

const SAMPLE = path.join(__dirname, "../app/sample/see-2081-sample.csv");
const DOCS = path.join(__dirname, "../app/docs");

/** A stand-in for MetaMask: an EIP-1193 provider that forwards to the node (Hardhat's unlocked accounts). */
function injectWallet({ rpcUrl, address, chainId, reject }) {
  let id = 0, switched = false;
  window.__sent = 0;
  const rpc = async (method, params = []) => {
    const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const j = await r.json();
    if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code, data: j.error.data });
    return j.result;
  };
  window.ethereum = {
    request: async ({ method, params }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [address];
      if (method === "eth_chainId" && chainId && !switched) return chainId;
      if (method === "wallet_switchEthereumChain") { switched = true; return null; }
      if (method === "eth_sendTransaction") {
        window.__sent++;
        if (reject) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
      }
      return rpc(method, params);
    },
  };
}

function raw(url, { method = "GET", host } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers: host ? { Host: host } : {} }, (res) => {
      res.resume();
      res.on("end", () => resolve({ code: res.statusCode, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("Day 29 — the web app end to end (Chromium + JSON-RPC node)", function () {
  this.timeout(120000);
  let browser, rpc, rpcUrl, f, app, cfg;

  before(async () => {
    await build({ quiet: true });
    rpc = await run(TASK_NODE_CREATE_SERVER, { hostname: "127.0.0.1", port: 0, provider: network.provider });
    const { port } = await rpc.listen();
    rpcUrl = `http://127.0.0.1:${port}`;
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await rpc?.close();
  });
  beforeEach(async () => {
    f = await deployFixture();
    cfg = { chainId: 31337, networkName: "Hardhat (local)", rpcUrl, contract: await f.p.getAddress() };
    app = await createAppServer({ config: cfg, port: 0 });
  });
  afterEach(async () => app.close());

  async function portal(signer, opts = {}) {
    const page = await browser.newPage();
    await page.addInitScript(injectWallet, { rpcUrl, address: signer.address, chainId: opts.chainId || null, reject: !!opts.reject });
    await page.goto(`${app.url}/portal.html`);
    await page.waitForSelector("body[data-ready='1']");
    return page;
  }

  async function verifyPage(link) {
    const page = await browser.newPage();
    await page.goto(link || `${app.url}/verify.html`);
    await page.waitForSelector("body[data-ready='1']");
    return page;
  }

  async function answerOf(page) {
    await page.waitForFunction(() => document.body.dataset.status && document.body.dataset.status !== "checking");
    return page.locator("#answer-title").textContent();
  }

  /** Publish a batch straight from a script (for statuses the portal can't create by itself). */
  async function publishDirect(signer, issuerId, certs) {
    const tree = buildBatch(issuerId, certs);
    await (await f.p.connect(signer).issueBatch(tree.root, certs.length)).wait();
    const batchId = Number(await f.p.batchCount());
    return certs.map((c) => C.verifyLink(app.url, C.encodePayload({ issuerId, batchId, cert: c.cert, salt: c.salt, proof: tree.proof(c.serial, c.docHash) })));
  }

  it("NEB publishes a CSV in one transaction; the QR image and every link verify; a changed grade and a revocation show", async () => {
    const page = await portal(f.neb);
    const sent = [];
    page.on("request", (r) => sent.push(`${r.url()} ${r.postData() || ""}`));
    await page.click("#connect");
    await page.getByText("Connected as National Examinations Board (institution #1).").waitFor();
    await page.setInputFiles("#csv", SAMPLE);
    await page.getByText(/^6 certificates ready/).waitFor();
    expect(await page.locator("#preview tbody tr").count()).to.equal(5);
    expect(await page.isDisabled("#publish")).to.equal(true); // no backup, no publish

    const [backup] = await Promise.all([page.waitForEvent("download"), page.click("#backup")]);
    const saved = JSON.parse(fs.readFileSync(await backup.path(), "utf8"));
    expect(saved.certs).to.have.length(6);
    expect(saved.certs.every((c) => /^0x[0-9a-f]{64}$/.test(c.salt))).to.equal(true);
    expect(await page.isDisabled("#publish")).to.equal(false);

    await page.locator("#publish").dblclick(); // an impatient double click
    await page.getByText(/^Published: batch #1, 6 certificates in one transaction/).waitFor();
    expect(await page.evaluate(() => window.__sent)).to.equal(1);
    expect(await f.p.batchCount()).to.equal(1n);
    expect(await page.isDisabled("#publish")).to.equal(true); // the same file can't be published twice
    const gasText = await page.locator("#publish-status").textContent();

    const [pack] = await Promise.all([page.waitForEvent("download"), page.click("#pack")]);
    const rows = C.parseCsv(fs.readFileSync(await pack.path(), "utf8"));
    expect(rows[0]).to.deep.equal(["certNo", "name", "dateOfBirth", "program", "result", "issuedOn", "verifyLink"]);
    expect(rows).to.have.length(7);
    const links = rows.slice(1).map((r) => r[6]);
    fs.mkdirSync(DOCS, { recursive: true });
    await page.screenshot({ path: path.join(DOCS, "portal.png"), fullPage: true });

    // Privacy: the only thing that left the browser was RPC traffic with hashes; no name, no salt.
    for (const s of sent) {
      for (const c of saved.certs) {
        expect(s).to.not.include(c.name);
        expect(s).to.not.include(c.salt.slice(2));
      }
    }

    // 1. Scan: upload the QR image the portal drew → VALID
    const qr = await page.locator("#qrs img").first().getAttribute("src");
    const qrFile = path.join(DOCS, "..", "..", "cache", "qr-test.png");
    fs.mkdirSync(path.dirname(qrFile), { recursive: true });
    fs.writeFileSync(qrFile, Buffer.from(qr.split(",")[1], "base64"));
    const v = await verifyPage();
    await v.setInputFiles("#qr-file", qrFile);
    expect(await answerOf(v)).to.equal("VALID");
    expect(await v.locator("#details").textContent()).to.include("National Examinations Board").and.include("SEE-2081-000101");

    // 2. Every link from the pack → VALID (including the Devanagari name and the name with a comma)
    for (const link of links) {
      const p = await verifyPage(link);
      expect(await answerOf(p)).to.equal("VALID");
      await p.close();
    }
    const sita = await verifyPage(links[2]);
    expect(await answerOf(sita)).to.equal("VALID");
    expect(await sita.locator("#details").textContent()).to.include("सीता कुमारी यादव");
    await sita.setViewportSize({ width: 420, height: 900 });
    await sita.screenshot({ path: path.join(DOCS, "verify-valid.png"), fullPage: true });

    // 3. A forger raises the grade in the QR → NOT FOUND
    const p0 = C.decodePayload(C.payloadFromLink(links[1]));
    const forged = C.verifyLink(app.url, C.encodePayload({ ...p0, cert: { ...p0.cert, result: "GPA 4.00" } }));
    const fv = await verifyPage(forged);
    expect(await answerOf(fv)).to.equal("NOT FOUND");
    expect(await fv.locator("#details tr").count()).to.equal(0); // a fake's claimed details are not shown

    // 4. NEB revokes one certificate for fraud from the portal → REVOKED
    await page.fill("#revoke-no", "SEE-2081-000102");
    await page.selectOption("#revoke-reason", "1");
    await page.click("#revoke");
    await page.getByText("Certificate SEE-2081-000102 revoked. Every verifier now sees REVOKED.").waitFor();
    const rv = await verifyPage(links[1]);
    expect(await answerOf(rv)).to.equal("REVOKED");
    expect(await rv.locator("#answer-text").textContent()).to.include("Reason: fraud");

    // 5. Nothing about any certificate reached the web server (the #fragment stays in the browser)
    for (const u of app.seen) expect(u).to.not.match(/#|c=|Aarati|SEE-2081/);
    console.log(`      ${gasText}`);
  });

  it("a lost pack is rebuilt from the backup, only if the chain agrees", async () => {
    const page = await portal(f.neb);
    await page.click("#connect");
    await page.getByText(/^Connected as/).waitFor();
    await page.setInputFiles("#csv", SAMPLE);
    await page.getByText(/^6 certificates ready/).waitFor();
    const [backup] = await Promise.all([page.waitForEvent("download"), page.click("#backup")]);
    await page.click("#publish");
    await page.getByText(/^Published: batch #1/).waitFor();
    await page.reload(); // the pack is gone
    await page.waitForSelector("body[data-ready='1']");
    await page.click("#connect");
    await page.getByText(/^Connected as/).waitFor();
    await page.setInputFiles("#restore-file", await backup.path());
    await page.fill("#restore-batch", "1");
    await page.click("#restore");
    await page.getByText("Pack rebuilt for batch #1.").waitFor();
    const link = await page.locator("#qrs a").first().getAttribute("href");
    expect(await answerOf(await verifyPage(link))).to.equal("VALID");
    // A backup can't be attached to someone else's batch
    const other = cert(900, { issuerId: 2 });
    await publishDirect(f.tu, 2, [other]);
    await page.fill("#restore-batch", "2");
    await page.click("#restore");
    await page.getByText("batch #2 on-chain does not match this backup").waitFor();
    // ...nor to another batch of the same institution (different root)
    await publishDirect(f.neb, 1, [cert(901)]);
    await page.fill("#restore-batch", "3");
    await page.click("#restore");
    await page.getByText("batch #3 on-chain does not match this backup").waitFor();
  });

  it("wrong network, a key that is not an institution, a suspended institution and a rejected transaction", async () => {
    const wrong = await portal(f.neb, { chainId: "0x1" });
    await wrong.click("#connect");
    await wrong.getByText(/^Wrong network: your wallet is on chain 1/).waitFor();
    await wrong.setInputFiles("#csv", SAMPLE);
    expect(await wrong.isDisabled("#publish")).to.equal(true);
    await wrong.click("#switch");
    await wrong.getByText(/^Connected as National Examinations Board/).waitFor();

    const stranger = await portal(f.other);
    await stranger.click("#connect");
    await stranger.getByText(/not a registered institution key/).waitFor();
    expect(await stranger.isDisabled("#revoke")).to.equal(true);

    await f.p.setIssuerActive(2, false);
    const tu = await portal(f.tu);
    await tu.click("#connect");
    await tu.getByText("Tribhuvan University is suspended by the council. Publishing is disabled.").waitFor();
    await f.p.setIssuerActive(2, true);

    const rej = await portal(f.neb, { reject: true });
    await rej.click("#connect");
    await rej.getByText(/^Connected as/).waitFor();
    await rej.setInputFiles("#csv", SAMPLE);
    await rej.getByText(/^6 certificates ready/).waitFor();
    await Promise.all([rej.waitForEvent("download"), rej.click("#backup")]);
    await rej.click("#publish");
    await rej.getByText("You rejected the transaction in your wallet. Nothing was published.").waitFor();
    expect(await f.p.batchCount()).to.equal(0n);
    expect(await rej.isDisabled("#publish")).to.equal(false); // can try again
  });

  it("a bad CSV is refused with line numbers and nothing is prepared", async () => {
    const page = await portal(f.neb);
    await page.click("#connect");
    await page.getByText(/^Connected as/).waitFor();
    const bad = path.join(__dirname, "../cache/bad.csv");
    fs.writeFileSync(bad, "certNo,name,dateOfBirth,program,result,issuedOn\nA-1,Ram,2065,SEE,GPA 3,2081\na-1,Sita,2065,SEE,GPA 3,2081\nA-3,,2065,SEE,GPA 3,2081\n");
    await page.setInputFiles("#csv", bad);
    await page.getByText(/^2 problem\(s\) found/).waitFor();
    expect(await page.locator("#errors li").allTextContents()).to.deep.equal(["line 3: certificate number a-1 is also on line 2", "line 4: name is empty"]);
    expect(await page.isDisabled("#backup")).to.equal(true);
  });

  it("shows DISTRUSTED for a stolen key's fake, and text from a QR is never run as HTML", async () => {
    const evil = '<img src=x onerror="window.pwned=1">';
    const [xssLink] = await publishDirect(f.neb, 1, [cert(1, { name: evil })]);
    const x = await verifyPage(xssLink);
    expect(await answerOf(x)).to.equal("VALID");
    expect(await x.locator("#details").textContent()).to.include(evil);
    expect(await x.locator("#details img").count()).to.equal(0);
    expect(await x.evaluate(() => window.pwned)).to.equal(undefined);

    const [fakeLink] = await publishDirect(f.neb, 1, [cert(2, { name: "Fake Buyer" })]); // the thief, with NEB's stolen key
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    await f.p.reportCompromise(1, now - 60, f.nebNew.address);
    const d = await verifyPage(fakeLink);
    expect(await answerOf(d)).to.equal("DISTRUSTED");
  });

  it("F-5: a rogue college can't make the checker say a certificate is from NEB", async () => {
    // A registered (or hacked) small college publishes a batch, but writes NEB's id into the QR and the hash.
    await f.p.addIssuer(f.thief.address, "Rogue College");
    const c = cert(77, { issuerId: 1, name: "Bought Degree" }); // docHash made with issuerId 1 (NEB)
    const tree = buildBatch(3, [c]); // ...inside a batch that belongs to the college (id 3)
    await (await f.p.connect(f.thief).issueBatch(tree.root, 1)).wait();
    const link = C.verifyLink(app.url, C.encodePayload({ issuerId: 1, batchId: 1, cert: c.cert, salt: c.salt, proof: tree.proof(c.serial, c.docHash) }));
    const v = await verifyPage(link);
    expect(await answerOf(v)).to.equal("NOT FOUND");
    expect(await v.locator("#details").textContent()).to.not.include("National Examinations Board");
  });

  it("F-6: hidden controls stay hidden (no 'Switch network' on the right chain, no test wallet in production)", async () => {
    const page = await portal(f.neb);
    await page.click("#connect");
    await page.getByText(/^Connected as/).waitFor();
    expect(await page.isVisible("#switch")).to.equal(false);
    expect(await page.isVisible("#dev")).to.equal(false);
    const v = await verifyPage();
    expect(await v.isVisible("#warning")).to.equal(false);
  });

  it("warns when a QR points to another website, refuses junk, and an RPC outage is 'could not check', not 'fake'", async () => {
    const [link] = await publishDirect(f.neb, 1, [cert(3)]);
    const phish = link.replace(app.url, "https://pramaan-verify.example.com");
    const v = await verifyPage();
    await v.fill("#paste", phish);
    await v.click("#paste-form button");
    expect(await answerOf(v)).to.equal("VALID");
    expect(await v.locator("#warning").textContent()).to.include("points to another website (pramaan-verify.example.com)");

    await v.fill("#paste", "https://evil.example/login?user=1");
    await v.click("#paste-form button");
    expect(await answerOf(v)).to.equal("NOT A PRAMAAN QR CODE");

    const down = await createAppServer({ config: { ...cfg, rpcUrl: "http://127.0.0.1:9" }, port: 0 });
    try {
      const p = await browser.newPage();
      await p.goto(link.replace(app.url, down.url));
      expect(await answerOf(p)).to.equal("COULD NOT CHECK");
    } finally {
      await down.close();
    }
  });

  it("the server only serves its own files, read-only, for localhost, with a strict CSP", async () => {
    const ok = await raw(`${app.url}/verify.html`);
    expect(ok.code).to.equal(200);
    expect(ok.headers["content-security-policy"]).to.include("script-src 'self'").and.include("frame-ancestors 'none'").and.include(`connect-src 'self' ${rpcUrl}`);
    expect(ok.headers["referrer-policy"]).to.equal("no-referrer");
    expect((await raw(`${app.url}/verify.html`, { host: "evil.example" })).code).to.equal(403);
    expect((await raw(`${app.url}/config.json`, { method: "POST" })).code).to.equal(405);
    expect((await raw(`${app.url}/..%2f..%2fpackage.json`)).code).to.equal(404);
    expect((await raw(`${app.url}/../server.js`)).code).to.equal(404);
  });
});
