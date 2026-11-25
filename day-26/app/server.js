// Day 26 — the "two chains" page: a small local server that
//   * starts L1 + L2 (or uses the ones you pass in), deploys, and measures costs,
//   * makes a block every second on both chains (like real networks),
//   * runs a relayer both ways (viem, 2-of-3 validators, 2 confirmations),
//   * serves a page where you send a task across and watch it arrive.
// Local demo only: it binds to 127.0.0.1 and sends from dev account #1.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");
const { startChains, devWallet } = require("../lib/chains");
const { deployBoth } = require("../lib/deploy");
const { createValidator, createRelayer } = require("../relayer/relayer");
const { measureCosts } = require("../lib/costs");

const MAX_BODY = 2048;
const HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};
const STATIC = { // fixed list: no path can reach outside public/
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
};

async function createApp({ chains, blockMs = 1000, pollMs = 300 } = {}) {
  const env = await deployBoth(chains);
  const costs = await measureCosts(env);
  const submitterKey = devWallet(9, chains.l1.provider).privateKey;
  const relayers = {};
  for (const [from, to] of [["l1", "l2"], ["l2", "l1"]]) {
    relayers[from] = createRelayer({
      src: chains[from], dst: chains[to], srcMessenger: env[from].address.messenger, dstMessenger: env[to].address.messenger,
      threshold: env.threshold, submitterKey, confirmations: 2,
      allowedTargets: [env[to].address.todo], // the relayer only pays for our own app
      fromBlock: BigInt(await chains[from].provider.getBlockNumber()) + 1n, // only messages sent from now on
      validators: env.validators.map((v) => createValidator({ privateKey: v.privateKey, src: chains[from], srcMessenger: env[from].address.messenger, dstChainId: chains[to].chainId, dstMessenger: env[to].address.messenger, confirmations: 2 })),
    });
  }
  const messages = []; // newest first: { id, from, to, text, status, sentBlock, deliveredGas }
  const users = { l1: devWallet(1, chains.l1.provider), l2: devWallet(1, chains.l2.provider) };

  // one job at a time per chain: blocks, sends and relays never race on nonces
  let queue = Promise.resolve();
  const serial = (fn) => (queue = queue.then(fn, fn));

  const timers = [
    setInterval(() => serial(async () => { for (const c of [chains.l1, chains.l2]) await c.provider.send("evm_mine", []); }), blockMs),
    setInterval(() => serial(async () => {
      for (const from of ["l1", "l2"]) {
        for (const r of await relayers[from].poll()) {
          const m = messages.find((x) => x.id === r.id);
          if (m && r.status === "delivered") Object.assign(m, { status: "delivered", deliveredGas: Number(r.gasUsed) });
          else if (m && r.status === "failed") m.status = "retrying";
        }
      }
    }).catch((e) => console.error("relay:", e.shortMessage || e.message)), pollMs),
  ];

  async function sendTask(body) {
    const direction = body && body.direction;
    const text = body && body.text;
    if (direction !== "l1-l2" && direction !== "l2-l1") throw new HttpError(400, "direction must be l1-l2 or l2-l1");
    if (typeof text !== "string" || text.trim() === "" || Buffer.byteLength(text) > 280) throw new HttpError(400, "text must be 1–280 bytes");
    const [from, to] = direction.split("-");
    return serial(async () => {
      const rc = await (await env[from].messenger.connect(users[from]).sendMessage(chains[to].chainId, env[to].address.todo, ethers.AbiCoder.defaultAbiCoder().encode(["string"], [text]))).wait();
      const ev = rc.logs.map((l) => { try { return env[from].messenger.interface.parseLog(l); } catch { return null; } }).find(Boolean);
      const m = { id: ev.args.id, from, to, text, nonce: Number(ev.args.message.nonce), status: "waiting for confirmations", sentBlock: rc.blockNumber };
      messages.unshift(m);
      if (messages.length > 50) messages.pop();
      return m;
    });
  }

  async function state() {
    const out = { chains: {}, messages, costs: costs.rows.map((r) => ({ action: r.action, gas: r.gasUsed, txBytes: r.txBytes, l1Usd: r.l1Usd, l2Usd: r.l2Usd, times: r.times, dataShare: r.dataShare })), prices: costs.prices, tasks: {} };
    for (const k of ["l1", "l2"]) {
      const other = k === "l1" ? "l2" : "l1";
      out.chains[k] = { name: k.toUpperCase(), chainId: chains[k].chainId, block: await chains[k].provider.getBlockNumber() };
      out.tasks[k] = (await env[k].todo.getTasks(chains[other].chainId, users[other].address)).map((t) => t.text);
    }
    out.user = users.l1.address;
    return out;
  }

  const server = http.createServer(async (req, res) => {
    const send = (status, obj) => { res.writeHead(status, { ...HEADERS, "Content-Type": "application/json" }); res.end(JSON.stringify(obj, (k, v) => (typeof v === "bigint" ? v.toString() : v))); };
    try {
      // F-3: DNS rebinding. A web page on evil.example can point its own name at 127.0.0.1
      // and then call this server "same-origin". The Host header still says evil.example.
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(String(req.headers.host || ""))) throw new HttpError(403, "bad host");
      const url = new URL(req.url, "http://x");
      if (req.method === "GET" && url.pathname === "/api/state") return send(200, await state());
      if (req.method === "POST" && url.pathname === "/api/send") {
        if (!String(req.headers["content-type"] || "").startsWith("application/json")) throw new HttpError(415, "send JSON");
        return send(200, await sendTask(await readJson(req)));
      }
      if (req.method === "GET" && Object.hasOwn(STATIC, url.pathname)) {
        const [file, type] = STATIC[url.pathname];
        res.writeHead(200, { ...HEADERS, "Content-Type": type });
        return res.end(fs.readFileSync(path.join(__dirname, "public", file)));
      }
      send(404, { error: "not found" });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      send(status, { error: status === 500 ? "server error" : e.message });
    }
  });

  return {
    env, relayers, messages,
    listen: (port = 4026, host = "127.0.0.1") => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => resolve(server.address().port)); }),
    close: async () => { timers.forEach(clearInterval); await queue.catch(() => {}); server.closeAllConnections?.(); await new Promise((r) => server.close(() => r())); },
  };
}

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { reject(new HttpError(413, "body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new HttpError(400, "invalid JSON")); } });
    req.on("error", reject);
  });
}

if (require.main === module) {
  (async () => {
    const chains = await startChains();
    const app = await createApp({ chains });
    const port = await app.listen(Number(process.env.PORT || 4026));
    console.log(`L1 ${chains.l1.url} (chain ${chains.l1.chainId}) · L2 ${chains.l2.url} (chain ${chains.l2.chainId})`);
    console.log(`Open http://127.0.0.1:${port}   (Ctrl+C to stop)`);
    const stop = async () => { await app.close(); await chains.stop(); process.exit(0); };
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
  })().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { createApp };
