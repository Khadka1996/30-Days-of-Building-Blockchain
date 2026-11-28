// Pramaan web app — the pure, shared part (runs in the browser and in Node tests).
//  1. The QR payload: everything a verifier needs, packed into the link's #fragment.
//     The fragment never leaves the verifier's browser (browsers don't send it to servers),
//     so the student's details are never logged by any web server.
//  2. A strict CSV reader / writer for the institution's exam results.
const { FIELDS, clean, serialOf, docHashOf } = require("../../lib/pramaan");

const VERSION = 1;
const MAX_FIELD = 200; // characters per field: keeps the QR code small enough to scan
const MAX_ROWS = 20000; // per CSV upload (one exam result); bigger files are split
const MAX_PROOF = 32; // a tree of 2^32 certificates; real proofs are ~14 hashes
const MAX_PAYLOAD = 4000; // characters; anything longer is not one of ours

// ───────────────────────────── base64url ─────────────────────────────
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function bytesToB64u(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += B64[n & 63];
  }
  return out;
}

function b64uToBytes(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new Error("bad base64url");
  const out = [];
  let buf = 0, bits = 0;
  for (const ch of s) {
    buf = (buf << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 255);
    }
  }
  return Uint8Array.from(out);
}

const hexToBytes = (h) => Uint8Array.from(h.slice(2).match(/../g).map((x) => parseInt(x, 16)));
const bytesToHex = (b) => "0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const h32ToB64u = (h) => bytesToB64u(hexToBytes(h));
function b64uToH32(s) {
  const b = b64uToBytes(s);
  if (b.length !== 32) throw new Error("expected 32 bytes");
  return bytesToHex(b);
}

// ───────────────────────────── QR payload ─────────────────────────────

/** Pack one certificate: [version, issuerId, batchId, [6 fields], salt, [proof]] → base64url(JSON). */
function encodePayload({ issuerId, batchId, cert, salt, proof }) {
  const json = JSON.stringify([VERSION, issuerId, batchId, FIELDS.map((f) => clean(cert[f])), h32ToB64u(salt), proof.map(h32ToB64u)]);
  return bytesToB64u(new TextEncoder().encode(json));
}

/**
 * Strictly unpack a payload. Anything unexpected throws, and the page then says
 * "not a Pramaan certificate" — it never guesses or fills in a missing part.
 */
function decodePayload(s) {
  if (typeof s !== "string" || s.length === 0 || s.length > MAX_PAYLOAD) throw new Error("payload missing or too long");
  let arr;
  try {
    arr = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b64uToBytes(s)));
  } catch {
    throw new Error("payload is not readable");
  }
  if (!Array.isArray(arr) || arr.length !== 6 || arr[0] !== VERSION) throw new Error("unknown payload version");
  const [, issuerId, batchId, values, salt, proof] = arr;
  if (!Number.isInteger(issuerId) || issuerId < 1 || issuerId > 0xffffffff) throw new Error("bad institution id");
  if (!Number.isSafeInteger(batchId) || batchId < 1) throw new Error("bad batch number");
  if (!Array.isArray(values) || values.length !== FIELDS.length) throw new Error("bad certificate fields");
  const cert = {};
  FIELDS.forEach((f, i) => {
    if (typeof values[i] !== "string" || !values[i] || values[i].length > MAX_FIELD) throw new Error(`bad field: ${f}`);
    cert[f] = values[i];
  });
  if (!Array.isArray(proof) || proof.length > MAX_PROOF) throw new Error("bad proof");
  return { issuerId, batchId, cert, salt: b64uToH32(salt), proof: proof.map(b64uToH32) };
}

/** Everything the contract needs, recomputed from what is printed (never taken on trust). */
function checkInputs(p) {
  return { serial: serialOf(p.cert.certNo), docHash: docHashOf(p.issuerId, p.cert, p.salt) };
}

function verifyLink(origin, payload) {
  return `${origin.replace(/\/$/, "")}/verify.html#c=${payload}`;
}

/** Read the payload out of a scanned or pasted link (or a bare payload). */
function payloadFromLink(text) {
  const t = String(text || "").trim();
  const m = t.match(/#c=([A-Za-z0-9_-]+)$/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]+$/.test(t)) return t;
  throw new Error("not a Pramaan link");
}

// ───────────────────────────── CSV ─────────────────────────────

/** RFC 4180 CSV: quoted fields, "" inside quotes, commas and new lines inside quotes, CRLF or LF. */
function parseCsv(text) {
  const s = String(text).replace(/^﻿/, "");
  const rows = [];
  let row = [], cell = "", i = 0, quoted = false;
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i += 2; continue; }
      if (ch === '"') { quoted = false; i++; continue; }
      cell += ch; i++; continue;
    }
    if (ch === '"' && cell === "") { quoted = true; i++; continue; }
    if (ch === ",") { row.push(cell); cell = ""; i++; continue; }
    if (ch === "\r" && s[i + 1] === "\n") i++;
    if (ch === "\n" || ch === "\r") { row.push(cell); rows.push(row); row = []; cell = ""; i++; continue; }
    cell += ch; i++;
  }
  if (quoted) throw new Error("unclosed quote in the CSV");
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

/**
 * Check an uploaded results file. Returns { certs, errors }; nothing is published unless errors is empty.
 * Every row needs all six fields, short enough for a QR code, and a certificate number used only once.
 */
function readResults(text) {
  const errors = [];
  let rows;
  try {
    rows = parseCsv(text);
  } catch (e) {
    return { certs: [], errors: [e.message] };
  }
  if (!rows.length) return { certs: [], errors: ["the file is empty"] };
  const header = rows[0].map((h) => h.trim());
  const missing = FIELDS.filter((f) => !header.includes(f));
  if (missing.length) return { certs: [], errors: [`missing column(s): ${missing.join(", ")} (needed: ${FIELDS.join(", ")})`] };
  const body = rows.slice(1);
  if (body.length > MAX_ROWS) return { certs: [], errors: [`${body.length} rows: at most ${MAX_ROWS} per upload, split the file`] };
  const certs = [];
  const seen = new Map();
  body.forEach((r, k) => {
    const line = k + 2;
    if (r.length !== header.length) { errors.push(`line ${line}: ${r.length} cells, expected ${header.length}`); return; }
    const cert = {};
    for (const f of FIELDS) {
      const v = clean(r[header.indexOf(f)]);
      if (!v) errors.push(`line ${line}: ${f} is empty`);
      else if (v.length > MAX_FIELD) errors.push(`line ${line}: ${f} is longer than ${MAX_FIELD} characters`);
      cert[f] = v;
    }
    const key = cert.certNo.toUpperCase();
    if (cert.certNo && seen.has(key)) errors.push(`line ${line}: certificate number ${cert.certNo} is also on line ${seen.get(key)}`);
    seen.set(key, line);
    certs.push(cert);
  });
  if (!certs.length && !errors.length) errors.push("no certificates in the file");
  return { certs, errors };
}

/**
 * One CSV cell. Cells that a spreadsheet would run as a formula (=, +, -, @, tab, CR) get a leading
 * apostrophe, so a student named "=HYPERLINK(...)" can't attack whoever opens the pack in Excel.
 */
function csvCell(v) {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

module.exports = {
  VERSION, MAX_FIELD, MAX_ROWS, MAX_PROOF, MAX_PAYLOAD,
  bytesToB64u, b64uToBytes, encodePayload, decodePayload, checkInputs, verifyLink, payloadFromLink,
  parseCsv, readResults, csvCell, toCsv,
};
