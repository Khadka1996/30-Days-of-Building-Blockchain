// Day 27 — the dashboard server. Read-only: one JSON endpoint and three static files.
// Binds to 127.0.0.1; refuses other Host headers (DNS rebinding) and sends a strict CSP.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const HEADERS = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};
const STATIC = { // fixed list: no request path can reach outside public/
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
};
const toJson = (x) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

function createDashboard({ monitor, port = 4027, host = "127.0.0.1" }) {
  const server = http.createServer((req, res) => {
    const send = (code, type, body) => { res.writeHead(code, { ...HEADERS, "Content-Type": type }); res.end(body); };
    try {
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(String(req.headers.host || ""))) return send(403, "text/plain", "forbidden host");
      if (req.method !== "GET") return send(405, "text/plain", "read-only");
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/api/state") return send(200, "application/json", toJson(monitor.snapshot()));
      const file = STATIC[url.pathname];
      if (!file) return send(404, "text/plain", "not found");
      return send(200, file[1], fs.readFileSync(path.join(__dirname, "public", file[0])));
    } catch {
      return send(500, "text/plain", "error");
    }
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve({ server, url: `http://${host}:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

module.exports = { createDashboard };
