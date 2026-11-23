// Strict EIP-4361 ("Sign in with Ethereum") message checks, used by the server.
//
// A SIWE message is plain text the wallet shows to the user, e.g.
//
//   127.0.0.1:4024 wants you to sign in with your Ethereum account:
//   0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
//
//   Sign in to the Day 24 to-do app.
//
//   URI: http://127.0.0.1:4024
//   Version: 1
//   Chain ID: 31337
//   Nonce: 3f1c...
//   Issued At: 2026-11-24T10:00:00.000Z
//   Expiration Time: 2026-11-24T10:10:00.000Z
//
// The signature only proves "this key signed this text". Every protection
// against replay and phishing comes from the server checking the TEXT:
//   domain + URI  → the signature was made for THIS site (not a phishing copy)
//   chain ID      → for THIS chain
//   nonce         → for THIS login attempt, once (no replay)
//   times         → recently, and not after it expired
const { parseSiweMessage, createSiweMessage } = require("viem/siwe");
const { getAddress, isAddress } = require("viem");

class SiweError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "SiweError";
  }
}

const MAX_MESSAGE_LENGTH = 2000; // a normal message is ~350 bytes
const NONCE_RE = /^[a-zA-Z0-9]{16,64}$/;

/**
 * Parse `text` and check every field against what this server expects.
 * Throws SiweError(reason) on the first problem; returns the parsed fields.
 *
 * @param {string} text the exact text the wallet signed
 * @param {object} expect { domain, origin, chainId, nonce, now (ms), maxAgeMs, clockSkewMs }
 */
function checkSiweMessage(text, expect) {
  if (typeof text !== "string" || text.length === 0) throw new SiweError("message missing");
  if (text.length > MAX_MESSAGE_LENGTH) throw new SiweError("message too long");

  const m = parseSiweMessage(text);
  for (const field of ["domain", "address", "uri", "version", "chainId", "nonce", "issuedAt"]) {
    if (m[field] === undefined) throw new SiweError(`missing field: ${field}`);
  }

  // viem's parser is forgiving: it ignores unknown or repeated lines and
  // accepts lower-case addresses. A forgiving parser lets an attacker hide
  // a second "Nonce:" or "URI:" line that a different parser would read
  // differently. So we rebuild the message from the parsed fields and demand
  // the result is byte-for-byte the text that was signed. (QA.md, defence D-01.)
  if (!isAddress(m.address, { strict: true }) || getAddress(m.address) !== m.address) {
    throw new SiweError("address must be EIP-55 checksummed");
  }
  let rebuilt;
  try {
    rebuilt = createSiweMessage(m);
  } catch {
    throw new SiweError("message is not valid EIP-4361");
  }
  if (rebuilt !== text) throw new SiweError("message is not in exact EIP-4361 form");

  // Phishing: the domain and URI must be OURS. A phishing site that tricks a
  // user into signing gets a message naming the phishing domain, which we refuse.
  if (m.domain !== expect.domain) throw new SiweError(`wrong domain: ${m.domain}`);
  let uriOrigin;
  try {
    uriOrigin = new URL(m.uri).origin;
  } catch {
    throw new SiweError("bad URI");
  }
  if (uriOrigin !== expect.origin) throw new SiweError(`wrong URI: ${m.uri}`);

  if (m.version !== "1") throw new SiweError("unsupported version");
  if (m.chainId !== expect.chainId) throw new SiweError(`wrong chain ID: ${m.chainId}`);

  // Replay: the nonce must be the one we just gave this browser.
  if (!NONCE_RE.test(m.nonce)) throw new SiweError("bad nonce format");
  if (!expect.nonce || m.nonce !== expect.nonce) throw new SiweError("unknown or used nonce");

  // Time window. Allow a little clock difference between browser and server.
  const now = expect.now;
  const skew = expect.clockSkewMs;
  const issued = m.issuedAt.getTime();
  if (Number.isNaN(issued)) throw new SiweError("bad issuedAt");
  if (issued > now + skew) throw new SiweError("issued in the future");
  if (issued < now - expect.maxAgeMs) throw new SiweError("message too old");
  if (m.expirationTime) {
    if (m.expirationTime.getTime() <= now) throw new SiweError("message expired");
    if (m.expirationTime.getTime() <= issued) throw new SiweError("expires before it was issued");
  }
  if (m.notBefore && m.notBefore.getTime() > now + skew) throw new SiweError("message not yet valid");

  return m;
}

module.exports = { checkSiweMessage, SiweError, MAX_MESSAGE_LENGTH };
