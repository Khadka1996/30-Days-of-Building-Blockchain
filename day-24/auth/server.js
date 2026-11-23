// Day 24 — "Sign in with Ethereum" server: log in with a wallet, no password.
//
//   1. GET  /api/nonce   → a fresh random nonce, tied to this browser by a
//                          short-lived "pre-login" cookie
//   2. the browser builds an EIP-4361 message with that nonce; the wallet signs it
//   3. POST /api/login   → we check the message text (siwe-check.js), burn the
//                          nonce, verify the signature (normal keys AND smart
//                          wallets via ERC-1271), then start a session
//   4. GET  /api/me      → who is signed in + their Day 1 to-do tasks
//   5. POST /api/logout  → end the session
//
// Plain Node `http`, no framework, so every security decision is visible.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { checkSiweMessage, SiweError } = require("./siwe-check");

const PRE_COOKIE = "siwe_pre";
const SESSION_COOKIE = "siwe_session";
const MAX_BODY = 8 * 1024;
const SIG_RE = /^0x[0-9a-fA-F]{2,4096}$/; // 65-byte EOA sigs, longer for smart wallets

// The only files we serve: fixed names, never a path from the request.
const PUBLIC = path.join(__dirname, "..", "public");
const FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
};

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

/** 32 random bytes as text: impossible to guess. */
const randomId = () => crypto.randomBytes(32).toString("base64url");
/** SIWE nonces must be letters and digits only (EIP-4361). 128 bits of randomness. */
const randomNonce = () => crypto.randomBytes(16).toString("hex");

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/**
 * @param {object} opts
 * @param {object} opts.client      viem public client (used for signature checks and reading the to-do list)
 * @param {number} opts.chainId     the only chain we accept logins for
 * @param {string} [opts.origin]    e.g. "http://127.0.0.1:4024"; if omitted, set from the port at listen()
 * @param {object} [opts.todo]      { address, abi } of the Day 1 TodoList (optional)
 * @param {string} [opts.statement] text shown in the wallet
 */
function createAuthServer(opts) {
  const cfg = {
    statement: "Sign in to the Day 24 to-do app. This costs nothing and sends no transaction.",
    sessionTtlMs: 60 * 60 * 1000, // 1 hour
    nonceTtlMs: 5 * 60 * 1000, // a nonce must be used within 5 minutes
    clockSkewMs: 60 * 1000,
    maxPending: 10_000, // cap on unused nonces (memory DoS guard)
    maxSessionsPerAddress: 5, // a key that logs in again and again can't fill our memory (QA F-02)
    now: () => Date.now(),
    ...opts,
  };
  const pending = new Map(); // pre-login cookie → { nonce, expiresAt }
  const sessions = new Map(); // session cookie → { address, expiresAt }
  const secure = () => cfg.origin.startsWith("https://");

  function cookie(name, value, maxAgeSec) {
    // HttpOnly: page scripts can't read it (an XSS can't steal the session).
    // SameSite=Strict: the browser never sends it on requests started by other sites.
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure() ? "; Secure" : ""}`;
  }

  function prune(now) {
    for (const [k, v] of pending) if (v.expiresAt <= now) pending.delete(k);
    for (const [k, v] of sessions) if (v.expiresAt <= now) sessions.delete(k);
  }

  function send(res, status, body, headers = {}) {
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    });
    res.end(JSON.stringify(body));
  }

  function currentSession(req) {
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!sid) return null;
    const s = sessions.get(sid);
    if (!s) return null;
    if (s.expiresAt <= cfg.now()) {
      sessions.delete(sid);
      return null;
    }
    return { sid, ...s };
  }

  /** Read a small JSON body. Rejects big bodies and non-JSON content types. */
  function readJson(req) {
    return new Promise((resolve, reject) => {
      if (!(req.headers["content-type"] || "").startsWith("application/json")) {
        return reject(Object.assign(new Error("Content-Type must be application/json"), { status: 415 }));
      }
      let size = 0;
      let tooBig = false;
      const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (tooBig) return; // keep draining, store nothing
        if (size > MAX_BODY) {
          // Don't destroy the socket: the client would get "connection closed"
          // instead of a clear 413. Stop storing, answer, and drain the rest.
          tooBig = true;
          chunks.length = 0;
          reject(Object.assign(new Error("body too large"), { status: 413 }));
        } else chunks.push(c);
      });
      req.on("end", () => {
        if (tooBig) return;
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          reject(Object.assign(new Error("invalid JSON"), { status: 400 }));
        }
      });
      req.on("error", reject);
    });
  }

  /** Login CSRF guard: state-changing calls must come from our own page. */
  function sameOrigin(req) {
    return req.headers.origin === cfg.origin;
  }

  async function handleNonce(req, res) {
    const now = cfg.now();
    if (pending.size >= cfg.maxPending) prune(now);
    if (pending.size >= cfg.maxPending) return send(res, 503, { error: "Too many sign-ins in progress, try again soon" });
    const pre = randomId();
    const nonce = randomNonce();
    pending.set(pre, { nonce, expiresAt: now + cfg.nonceTtlMs });
    send(res, 200, { nonce, chainId: cfg.chainId, domain: new URL(cfg.origin).host, statement: cfg.statement }, {
      "Set-Cookie": cookie(PRE_COOKIE, pre, Math.floor(cfg.nonceTtlMs / 1000)),
    });
  }

  async function handleLogin(req, res) {
    if (!sameOrigin(req)) return send(res, 403, { error: "Cross-site request refused" });
    const body = await readJson(req);
    const { message, signature } = body || {};

    // Burn the nonce FIRST, before any await: each nonce gets exactly one try,
    // even if two requests race with the same signed message. (QA.md, defence D-03.)
    const pre = parseCookies(req.headers.cookie)[PRE_COOKIE];
    const entry = pre ? pending.get(pre) : undefined;
    if (pre) pending.delete(pre);
    const now = cfg.now();
    const nonce = entry && entry.expiresAt > now ? entry.nonce : undefined;
    const clearPre = cookie(PRE_COOKIE, "", 0);

    let fields;
    try {
      if (typeof signature !== "string" || !SIG_RE.test(signature)) throw new SiweError("bad signature format");
      fields = checkSiweMessage(message, {
        domain: new URL(cfg.origin).host,
        origin: cfg.origin,
        chainId: cfg.chainId,
        nonce,
        now,
        maxAgeMs: cfg.nonceTtlMs,
        clockSkewMs: cfg.clockSkewMs,
      });
    } catch (e) {
      if (e instanceof SiweError) return send(res, 401, { error: `Sign-in refused: ${e.message}` }, { "Set-Cookie": clearPre });
      throw e;
    }

    // verifyMessage handles both kinds of account: a normal key (ecrecover) and a
    // smart wallet (it calls the contract's ERC-1271 isValidSignature).
    let valid = false;
    try {
      valid = await cfg.client.verifyMessage({ address: fields.address, message, signature });
    } catch {
      valid = false; // malformed signature or a reverting wallet = not valid
    }
    if (!valid) return send(res, 401, { error: "Sign-in refused: signature does not match the address" }, { "Set-Cookie": clearPre });

    // New random session id (never reuse the pre-login id: session fixation).
    const sid = randomId();
    let expiresAt = now + cfg.sessionTtlMs;
    if (fields.expirationTime) expiresAt = Math.min(expiresAt, fields.expirationTime.getTime());
    // Keep at most N sessions per address: drop the oldest (Maps keep insertion order).
    const mine = [...sessions].filter(([, v]) => v.address === fields.address);
    for (const [oldSid] of mine.slice(0, Math.max(0, mine.length - cfg.maxSessionsPerAddress + 1))) sessions.delete(oldSid);
    sessions.set(sid, { address: fields.address, expiresAt });
    send(res, 200, { address: fields.address, expiresAt: new Date(expiresAt).toISOString() }, {
      "Set-Cookie": [clearPre, cookie(SESSION_COOKIE, sid, Math.max(1, Math.floor((expiresAt - now) / 1000)))],
    });
  }

  async function handleMe(req, res) {
    const s = currentSession(req);
    if (!s) return send(res, 401, { error: "Not signed in" });
    let tasks = [];
    if (cfg.todo) {
      try {
        const raw = await cfg.client.readContract({ ...cfg.todo, functionName: "getTasks", args: [s.address] });
        tasks = raw.map((t) => ({ id: Number(t.id), text: t.text, completed: t.completed }));
      } catch {
        tasks = null; // chain unreachable: still signed in, just no tasks
      }
    }
    send(res, 200, { address: s.address, expiresAt: new Date(s.expiresAt).toISOString(), tasks });
  }

  async function handleLogout(req, res) {
    if (!sameOrigin(req)) return send(res, 403, { error: "Cross-site request refused" });
    const s = currentSession(req);
    if (s) sessions.delete(s.sid); // server-side: the old cookie is dead even if someone copied it
    send(res, 200, { ok: true }, { "Set-Cookie": cookie(SESSION_COOKIE, "", 0) });
  }

  const routes = {
    "GET /api/nonce": handleNonce,
    "POST /api/login": handleLogin,
    "GET /api/me": handleMe,
    "POST /api/logout": handleLogout,
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      const route = routes[`${req.method} ${url.pathname}`];
      if (route) return await route(req, res);
      if (url.pathname.startsWith("/api/")) return send(res, routes[`GET ${url.pathname}`] || routes[`POST ${url.pathname}`] ? 405 : 404, { error: "Not found" });
      const file = FILES[url.pathname];
      if (!file || req.method !== "GET") {
        res.writeHead(file ? 405 : 404, SECURITY_HEADERS);
        return res.end();
      }
      res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": file[1], "Cache-Control": "no-store" });
      res.end(fs.readFileSync(path.join(PUBLIC, file[0])));
    } catch (e) {
      if (res.headersSent) return res.end();
      // After a 413, close the connection so a client can't keep streaming a huge body.
      send(res, e.status || 500, { error: e.status ? e.message : "Server error" }, e.status === 413 ? { Connection: "close" } : {});
    }
  });

  return {
    server,
    sessions,
    pending,
    config: cfg,
    listen(port = 4024, host = "127.0.0.1") {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          const actual = server.address().port;
          if (!cfg.origin) cfg.origin = `http://${host}:${actual}`;
          resolve(actual);
        });
      });
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

module.exports = { createAuthServer, parseCookies };

// `npm run app`: serve against the local chain started with `npm run chain`.
if (require.main === module) {
  const { createPublicClient, http: httpTransport } = require("viem");
  const rpc = process.env.RPC_URL || "http://127.0.0.1:8545";
  const deployments = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments.json"), "utf8"));
  const client = createPublicClient({ transport: httpTransport(rpc), cacheTime: 0 });
  const app = createAuthServer({
    client,
    chainId: deployments.chainId,
    todo: { address: deployments.TodoList, abi: deployments.todoAbi },
    origin: process.env.ORIGIN || "http://127.0.0.1:4024",
  });
  app.listen(Number(process.env.PORT || 4024)).then((p) => console.log(`Sign in with Ethereum: http://127.0.0.1:${p}  (chain ${rpc})`));
}
