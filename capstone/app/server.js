// A tiny static server for running the Pramaan web app locally. In production the app is just
// static files (public/ + config.json) on any static host; DEPLOY.md lists the headers to set.
// It only serves files from public/, only answers GET/HEAD, and only for localhost (no DNS rebinding).
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const PUBLIC = path.join(__dirname, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };

/** Security headers: scripts only from this site, the RPC as the only other place to talk to, no framing. */
function headers(config) {
  const rpc = new URL(config.rpcUrl).origin;
  return {
    "Content-Security-Policy": `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' ${rpc}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'`,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
  };
}

function createAppServer({ config, port = 4029, host = "127.0.0.1" }) {
  const seen = []; // every path the server was asked for (tests check no certificate data ever arrives)
  const sec = headers(config);
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    const send = (code, body = "", type = "text/plain; charset=utf-8") => {
      res.writeHead(code, { ...sec, "Content-Type": type, "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? "" : body);
    };
    const allowedHost = new RegExp(`^(127\\.0\\.0\\.1|localhost):${server.address().port}$`);
    if (!allowedHost.test(req.headers.host || "")) return send(403, "forbidden host");
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, "read-only");
    let p;
    try {
      p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    } catch {
      return send(400, "bad path");
    }
    if (p === "/") p = "/index.html";
    if (p === "/config.json") return send(200, JSON.stringify(config), TYPES[".json"]);
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(404, "not found");
    send(200, fs.readFileSync(file), TYPES[path.extname(file)] || "application/octet-stream");
  });
  return new Promise((resolve) =>
    server.listen(port, host, () => {
      const url = `http://${host}:${server.address().port}`;
      resolve({ url, seen, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) });
    }),
  );
}

module.exports = { createAppServer, headers };
