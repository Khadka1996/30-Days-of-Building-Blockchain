// The live activity feed: a tiny HTTP server that keeps the indexer in sync
// (polling, not a websocket subscription — a dropped socket silently misses
// events, a poll from a saved cursor cannot) and serves the feed as JSON.
//
//   npm run feed   →  http://127.0.0.1:4023
const http = require("http");
const fs = require("fs");
const path = require("path");

const PUBLIC = path.join(__dirname, "..", "public");
// Only these files are served: no user-controlled paths, so no path traversal.
const FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/feed.js": ["feed.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
};
const HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

function createFeedServer({ indexer, pollMs = 1000 }) {
  const status = { syncing: false, lastSync: null, error: null, rounds: 0 };
  let timer = null;

  async function tick() {
    if (status.syncing) return; // never run two syncs at once
    status.syncing = true;
    try {
      await indexer.sync();
      status.lastSync = Date.now();
      status.error = null;
      status.rounds++;
    } catch (err) {
      status.error = err.shortMessage || err.message; // keep serving the last good data
    } finally {
      status.syncing = false;
    }
  }

  const server = http.createServer((req, res) => {
    if (req.method !== "GET") { res.writeHead(405, HEADERS); return res.end(); }
    const url = req.url.split("?")[0];

    if (url === "/api/feed") {
      const s = indexer.state || {};
      const body = {
        chainId: s.chainId ?? null,
        head: s.head ?? null,
        cursor: s.cursor ?? null,
        confirmations: indexer.confirmations,
        total: Object.keys(s.events || {}).length,
        reorgs: s.reorgs || [],
        status: { lastSync: status.lastSync, error: status.error },
        events: indexer.feed(100),
      };
      res.writeHead(200, { ...HEADERS, "Content-Type": "application/json" });
      return res.end(JSON.stringify(body));
    }

    const file = FILES[url];
    if (!file) { res.writeHead(404, HEADERS); return res.end("not found"); }
    res.writeHead(200, { ...HEADERS, "Content-Type": file[1] });
    res.end(fs.readFileSync(path.join(PUBLIC, file[0])));
  });

  return {
    server,
    indexer,
    status,
    tick,
    async listen(port = 4023, host = "127.0.0.1") {
      // No init() here: sync() initialises on first success. If the chain is down
      // at start-up, the page still loads and shows the error (finding F-02).
      await tick();
      timer = setInterval(tick, pollMs);
      await new Promise((ok) => server.listen(port, host, ok));
      return server.address().port;
    },
    async close() {
      clearInterval(timer);
      await new Promise((ok) => server.close(ok));
    },
  };
}

module.exports = { createFeedServer };

// ---- run it: node indexer/server.js -------------------------------------
if (require.main === module) {
  const { createPublicClient, http: httpTransport } = require("viem");
  const { FileStore } = require("./store");
  const { Indexer } = require("./indexer");

  const root = path.join(__dirname, "..");
  const dep = path.join(root, "deployment.json");
  if (!fs.existsSync(dep)) {
    console.error("No deployment.json — run `npm run deploy` first.");
    process.exit(1);
  }
  const deployment = JSON.parse(fs.readFileSync(dep, "utf8"));
  const abi = (name) =>
    JSON.parse(fs.readFileSync(path.join(root, "artifacts/contracts", `${name}.sol`, `${name}.json`))).abi;

  const rpc = process.env.RPC_URL || "http://127.0.0.1:8545";
  const client = createPublicClient({ transport: httpTransport(rpc), cacheTime: 0 });
  const indexer = new Indexer({
    client,
    store: new FileStore(path.join(root, "data", "index.json")),
    confirmations: Number(process.env.CONFIRMATIONS || 3),
    contracts: Object.entries(deployment.contracts).map(([name, c]) => ({
      name, address: c.address, startBlock: c.block, abi: abi(name),
    })),
  });
  const feed = createFeedServer({ indexer });
  const port = Number(process.env.PORT || 4023);
  feed.listen(port).then(() => console.log(`Activity feed on http://127.0.0.1:${port} (RPC ${rpc})`));
}
