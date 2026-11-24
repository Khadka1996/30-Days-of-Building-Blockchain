// Day 25 — the relayer: a small HTTP server that pays the gas for users.
//
// A user signs an EIP-712 ForwardRequest in their wallet (free) and POSTs it here.
// The relayer sends it to the Forwarder contract and pays the gas from its own
// wallet. That makes the relayer a target: anyone on the internet can send it
// requests and try to make it waste ETH. So, in this order:
//
//   1. parse     strict shape and sizes                      (junk costs nothing)
//   2. policy    only our to-do contract, only its 3 write functions,
//                value 0, gas <= cap, deadline within 1 hour (no paying for other apps,
//                                                             no sending ETH, no time bombs)
//   3. signer    recover the signer OFF-CHAIN; must be `from` (forged requests can't
//                                                             use up a victim's quota)
//   4. quota     at most N relays per signer per minute        (spam)
//   5. in-flight one request per (signer, nonce) at a time    (nonce reuse / races)
//   6. queue     one transaction at a time, and inside it:
//                verify on-chain (nonce, deadline, signature) + simulate the call.
//                If it would fail, refuse: the relayer never pays for a revert.
//   7. send      with a gas limit from the estimate (+20%), wait for the receipt.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const {
  getAddress, isAddress, isHex, size, slice, toFunctionSelector, defineChain,
  recoverTypedDataAddress, decodeErrorResult, BaseError, ContractFunctionRevertedError,
} = require("viem");

const MAX_BODY = 16 * 1024;
const SIG_RE = /^0x[0-9a-fA-F]{130}$/;
const UINT_RE = /^(0|[1-9][0-9]{0,77})$/; // decimal string, no leading zeros
const FIELDS = ["from", "to", "value", "gas", "nonce", "deadline", "data"];

const DEFAULTS = {
  maxGas: 300_000n,          // the most gas one request may ask for
  maxDataBytes: 1024,        // addTask with a 280-byte text is ~420 bytes
  maxDeadlineAhead: 3600,    // a signature may live at most 1 hour
  ratePerMinute: 10,         // relays per signer per minute
  maxQueue: 50,              // requests waiting for the chain, across everyone
};

// The ForwardRequest type, exactly as in Forwarder.sol.
const TYPES = {
  ForwardRequest: [
    { name: "from", type: "address" }, { name: "to", type: "address" },
    { name: "value", type: "uint256" }, { name: "gas", type: "uint256" },
    { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint48" },
    { name: "data", type: "bytes" },
  ],
};

const HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};
// A fixed list of files, so no path can ever reach outside public/.
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * @param {object} cfg
 * @param {import("viem").PublicClient} cfg.publicClient
 * @param {import("viem").WalletClient} cfg.walletClient  the relayer's wallet (pays gas)
 * @param {`0x${string}`} cfg.relayer                     the relayer's address
 * @param {number} cfg.chainId
 * @param {{address:string, abi:any[]}} cfg.forwarder
 * @param {{address:string, abi:any[]}} cfg.todo           the ONLY contract we pay for
 * @param {object} [cfg.limits]                             overrides for DEFAULTS
 * @param {() => number|Promise<number>} [cfg.now]          unix seconds (tests pass the chain's clock)
 */
function createRelayer(cfg) {
  const limits = { ...DEFAULTS, ...(cfg.limits || {}) };
  const now = cfg.now || (() => Math.floor(Date.now() / 1000));
  const forwarder = { address: getAddress(cfg.forwarder.address), abi: cfg.forwarder.abi };
  const todo = { address: getAddress(cfg.todo.address), abi: cfg.todo.abi };
  // viem checks the node is on this chain before every send: the relayer never pays on the wrong chain
  const chain = defineChain({ id: cfg.chainId, name: `chain ${cfg.chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } });
  const sender = cfg.walletClient.account || cfg.relayer; // a local key, or an unlocked node account (dev only)
  const domain = { name: "Day25Forwarder", version: "1", chainId: cfg.chainId, verifyingContract: forwarder.address };

  // Only the three functions that change a to-do list. Reads are free anyway.
  const allowed = new Map(
    ["addTask", "completeTask", "deleteTask"].map((name) => {
      const item = todo.abi.find((x) => x.type === "function" && x.name === name);
      return [toFunctionSelector(item), name];
    }),
  );

  const recent = new Map();   // signer => [unix seconds of recent relays]
  const inFlight = new Set(); // "signer:nonce" currently being handled
  let queue = Promise.resolve();
  let queued = 0;
  const stats = { relayed: 0, refused: 0, gasPaid: 0n };

  // ---------- 1. parse ----------
  function parse(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be { request, signature }");
    const { request: r, signature } = body;
    if (typeof signature !== "string" || !SIG_RE.test(signature)) throw new HttpError(400, "signature must be 65 bytes of hex");
    if (!r || typeof r !== "object" || Array.isArray(r)) throw new HttpError(400, "request missing");
    const keys = Object.keys(r).sort();
    if (keys.join() !== [...FIELDS].sort().join()) throw new HttpError(400, `request must have exactly: ${FIELDS.join(", ")}`);
    for (const k of ["from", "to"]) if (typeof r[k] !== "string" || !isAddress(r[k], { strict: false })) throw new HttpError(400, `${k} is not an address`);
    for (const k of ["value", "gas", "nonce", "deadline"]) if (typeof r[k] !== "string" || !UINT_RE.test(r[k])) throw new HttpError(400, `${k} must be a decimal string`);
    if (typeof r.data !== "string" || !isHex(r.data, { strict: true }) || r.data.length % 2 !== 0) throw new HttpError(400, "data must be hex");
    if (size(r.data) > limits.maxDataBytes) throw new HttpError(400, "data too large");
    const req = {
      from: getAddress(r.from), to: getAddress(r.to), value: BigInt(r.value), gas: BigInt(r.gas),
      nonce: BigInt(r.nonce), deadline: Number(r.deadline), data: r.data,
    };
    if (!Number.isSafeInteger(req.deadline) || req.deadline >= 2 ** 48) throw new HttpError(400, "deadline out of range");
    return { req, signature };
  }

  // ---------- 2. policy: what this relayer is willing to pay for ----------
  function policy(req, t) {
    if (req.to !== todo.address) throw new HttpError(403, "this relayer only pays for the to-do contract");
    if (size(req.data) < 4 || !allowed.has(slice(req.data, 0, 4))) throw new HttpError(403, "function not allowed (only addTask, completeTask, deleteTask)");
    if (req.value !== 0n) throw new HttpError(403, "value must be 0: the relayer never sends ETH for you");
    if (req.gas > limits.maxGas) throw new HttpError(403, `gas must be at most ${limits.maxGas}`);
    if (req.deadline < t) throw new HttpError(400, "request expired");
    if (req.deadline > t + limits.maxDeadlineAhead) throw new HttpError(403, `deadline must be within ${limits.maxDeadlineAhead} s`);
  }

  // ---------- 4. quota ----------
  function takeQuota(signer, t) {
    const mine = (recent.get(signer) || []).filter((x) => x > t - 60);
    if (mine.length >= limits.ratePerMinute) throw new HttpError(429, "too many requests for this address, try again in a minute");
    mine.push(t);
    recent.set(signer, mine);
  }

  /** Run `fn` after every earlier job: one transaction at a time, no relayer-nonce clashes. */
  function enqueue(fn) {
    if (queued >= limits.maxQueue) throw new HttpError(503, "relayer busy, try again soon");
    queued++;
    const run = queue.then(fn);
    queue = run.catch(() => {}).finally(() => { queued--; });
    return run;
  }

  // ---------- 6 + 7. verify, simulate, send ----------
  async function preflight(req, signature) {
    const ok = await cfg.publicClient.readContract({ ...forwarder, functionName: "verify", args: [req, signature] });
    if (!ok) throw new HttpError(400, "not valid on-chain: nonce already used, expired, or bad signature");
    try {
      // simulate exactly what we will send, as the relayer (eth_call), then estimate the gas
      const call = { ...forwarder, functionName: "execute", args: [req, signature], account: cfg.relayer };
      await cfg.publicClient.simulateContract(call);
      return await cfg.publicClient.estimateContractGas(call);
    } catch (e) {
      throw new HttpError(400, `would fail on-chain: ${revertReason(e, todo.abi)}`);
    }
  }

  async function relay(req, signature) {
    const estimate = await preflight(req, signature);
    const hash = await cfg.walletClient.writeContract({
      ...forwarder, functionName: "execute", args: [req, signature],
      account: sender, chain, gas: (estimate * 12n) / 10n,
    });
    const receipt = await cfg.publicClient.waitForTransactionReceipt({ hash });
    stats.gasPaid += receipt.gasUsed * receipt.effectiveGasPrice;
    if (receipt.status !== "success") throw new HttpError(502, "transaction reverted");
    stats.relayed++;
    return { hash, gasUsed: receipt.gasUsed.toString(), blockNumber: receipt.blockNumber.toString() };
  }

  async function handleRelay(body) {
    const { req, signature } = parse(body);
    const t = await now();
    policy(req, t);
    // 3. who really signed this? (off-chain, costs nothing)
    let signer;
    try {
      signer = await recoverTypedDataAddress({ domain, types: TYPES, primaryType: "ForwardRequest", message: req, signature });
    } catch { throw new HttpError(401, "signature does not match the request"); }
    if (signer !== req.from) throw new HttpError(401, "signature does not match the request");
    takeQuota(signer, t);
    // 5. one try per (signer, nonce) at a time
    const key = `${signer}:${req.nonce}`;
    if (inFlight.has(key)) throw new HttpError(409, "this request is already being relayed");
    inFlight.add(key);
    try {
      return await enqueue(() => relay(req, signature));
    } finally {
      inFlight.delete(key);
    }
  }

  async function account(addr) {
    if (!isAddress(addr, { strict: false })) throw new HttpError(400, "not an address");
    const a = getAddress(addr);
    const [nonce, tasks, balance] = await Promise.all([
      cfg.publicClient.readContract({ ...forwarder, functionName: "nonces", args: [a] }),
      cfg.publicClient.readContract({ ...todo, functionName: "getTasks", args: [a] }),
      cfg.publicClient.getBalance({ address: a }),
    ]);
    return {
      address: a, nonce: nonce.toString(), balance: balance.toString(),
      tasks: tasks.map((t) => ({ id: t.id.toString(), completed: t.completed, text: t.text })),
    };
  }

  // ---------- HTTP ----------
  function send(res, status, body, headers = {}) {
    res.writeHead(status, { ...HEADERS, "Content-Type": "application/json; charset=utf-8", ...headers });
    res.end(JSON.stringify(body));
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      if (!(req.headers["content-type"] || "").startsWith("application/json")) return reject(new HttpError(415, "Content-Type must be application/json"));
      let total = 0, tooBig = false;
      const chunks = [];
      req.on("data", (c) => {
        total += c.length;
        if (tooBig) return; // keep draining, store nothing
        if (total > MAX_BODY) { tooBig = true; chunks.length = 0; reject(new HttpError(413, "body too large")); } else chunks.push(c);
      });
      req.on("end", () => {
        if (tooBig) return;
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new HttpError(400, "invalid JSON")); }
      });
      req.on("error", reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      if (req.method === "POST" && url.pathname === "/api/relay") {
        try {
          return send(res, 200, await handleRelay(await readJson(req)));
        } catch (e) { stats.refused++; throw e; }
      }
      if (req.method === "GET" && url.pathname === "/api/config") {
        return send(res, 200, {
          chainId: cfg.chainId, forwarder: forwarder.address, todo: todo.address, relayer: cfg.relayer, domain,
          types: TYPES, selectors: Object.fromEntries([...allowed].map(([sel, name]) => [name, sel])),
          maxGas: limits.maxGas.toString(), maxDeadlineAhead: limits.maxDeadlineAhead,
        });
      }
      const m = /^\/api\/account\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && m) return send(res, 200, await account(m[1]));
      if (req.method === "GET" && Object.hasOwn(STATIC, url.pathname)) {
        const [file, type] = STATIC[url.pathname];
        res.writeHead(200, { ...HEADERS, "Content-Type": type });
        return res.end(fs.readFileSync(path.join(__dirname, "..", "public", file)));
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      send(res, status, { error: status === 500 ? "server error" : e.message }, status === 413 ? { Connection: "close" } : {});
    }
  });

  return {
    server, stats, domain, types: TYPES,
    listen(port = 4025, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve(server.address().port));
      });
    },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

/** A short, human reason from a viem error (custom error name, or revert string). */
function revertReason(e, innerAbi) {
  if (e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (rev?.data?.errorName) {
      // CallFailed wraps the inner revert; that's the useful part
      if (rev.data.errorName === "CallFailed") {
        try { return decodeErrorResult({ abi: innerAbi, data: rev.data.args[0] }).errorName; } catch { return "the to-do contract refused it"; }
      }
      return rev.data.errorName;
    }
    if (rev?.reason) return rev.reason;
    return e.shortMessage;
  }
  return String(e?.message || e);
}

module.exports = { createRelayer, TYPES, DEFAULTS };
