// Pramaan off-chain helpers: how an institution turns a certificate into the two hashes the
// contract stores, and how a batch (a whole exam result) becomes one Merkle root.
// Uses ethers only. The tree code is the Day 10 airdrop tree with a different leaf.
const { AbiCoder, concat, hexlify, keccak256, randomBytes, toUtf8Bytes } = require("ethers");

const coder = AbiCoder.defaultAbiCoder();

// The printed fields, in a fixed order. Changing any of them changes the hash.
const FIELDS = ["certNo", "name", "dateOfBirth", "program", "result", "issuedOn"];

// Same text must give the same hash on every computer: Unicode NFC (Devanagari names can be
// typed in two ways), trimmed, single spaces. Case is kept: "Ram" and "RAM" are different prints.
function clean(value) {
  if (typeof value !== "string") throw new Error("certificate fields must be strings");
  return value.normalize("NFC").trim().replace(/\s+/g, " ");
}

/** serial = keccak256(certificate number). Certificate numbers are printed, so not secret. */
function serialOf(certNo) {
  const c = clean(certNo).toUpperCase();
  if (!c) throw new Error("empty certificate number");
  return keccak256(toUtf8Bytes(c));
}

/** A fresh 32-byte salt, printed only in the certificate's QR code. */
function newSalt() {
  return hexlify(randomBytes(32));
}

/**
 * docHash = keccak256(abi.encode(issuerId, fields..., salt)).
 * The issuer id is inside, so a copy published by another institution never matches (F-1).
 * The salt stops anyone guessing a student's details from the public hash: without it, a name,
 * a birthday and a result could be brute-forced in seconds.
 */
function docHashOf(issuerId, cert, salt) {
  if (!Number.isInteger(issuerId) || issuerId < 1) throw new Error("issuerId must be a positive integer");
  if (!/^0x[0-9a-fA-F]{64}$/.test(salt || "")) throw new Error("salt must be 32 bytes hex");
  for (const f of FIELDS) if (!clean(cert[f] ?? "")) throw new Error(`missing field: ${f}`);
  const values = FIELDS.map((f) => clean(cert[f]));
  return keccak256(coder.encode(["uint32", ...FIELDS.map(() => "string"), "bytes32"], [issuerId, ...values, salt]));
}

// The contract's leaf: double hash, so an inner node of the tree can never pass as a leaf.
function leafOf(issuerId, serial, docHash) {
  return keccak256(keccak256(coder.encode(["uint32", "bytes32", "bytes32"], [issuerId, serial, docHash])));
}

// Sorted pairs, like OpenZeppelin's MerkleProof, so a proof needs no left/right flags.
function hashPair(a, b) {
  return BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

/**
 * Build a batch for institution `issuerId` from [{ serial, docHash }]. Returns { root, count, proof(serial, docHash) }.
 * A serial may appear only once per batch: otherwise two different documents would both verify.
 */
function buildBatch(issuerId, items) {
  if (!items.length) throw new Error("empty batch");
  const seen = new Set();
  const leaves = items.map(({ serial, docHash }) => {
    if (seen.has(serial)) throw new Error(`duplicate serial in batch: ${serial}`);
    seen.add(serial);
    return leafOf(issuerId, serial, docHash);
  });
  const levels = [[...leaves].sort()];
  while (levels[levels.length - 1].length > 1) {
    const below = levels[levels.length - 1];
    const above = [];
    for (let i = 0; i < below.length; i += 2) above.push(i + 1 < below.length ? hashPair(below[i], below[i + 1]) : below[i]);
    levels.push(above);
  }
  const index = new Map(levels[0].map((l, i) => [l, i]));
  function proof(serial, docHash) {
    let pos = index.get(leafOf(issuerId, serial, docHash));
    if (pos === undefined) throw new Error("not in this batch");
    const out = [];
    for (let d = 0; d < levels.length - 1; d++) {
      const sib = pos % 2 === 0 ? pos + 1 : pos - 1;
      if (sib < levels[d].length) out.push(levels[d][sib]);
      pos = Math.floor(pos / 2);
    }
    return out;
  }
  return { root: levels[levels.length - 1][0], count: items.length, proof };
}

const STATUS = ["Unknown", "Valid", "Revoked", "Distrusted"];
const REASON = { 1: "fraud", 2: "error, re-issued with a new serial", 3: "withdrawn by the institution" };

module.exports = { FIELDS, clean, serialOf, newSalt, docHashOf, leafOf, buildBatch, STATUS, REASON };
