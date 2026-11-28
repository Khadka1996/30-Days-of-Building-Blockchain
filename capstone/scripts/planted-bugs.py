#!/usr/bin/env python3
"""Pramaan — plant real security bugs one at a time and check the tests catch each one.

For every bug: change one line, run the tests, then restore the file.
A bug is "caught" when at least one test fails. All must be caught.
    npm run planted-bugs
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
C, L = "contracts/Pramaan.sol", "lib/pramaan.js"
T, LT = "test/Pramaan.test.js", "test/lib.test.js"
# Day 29: the web app
V, PO, CH, CO, SV = "app/src/verify.js", "app/src/portal.js", "app/src/chain.js", "app/src/codec.js", "app/server.js"
E, AT = "test/e2e.test.js", "test/app.test.js"

BUGS = [
    # (name, file, old, new, test file)
    ("anyone can register an institution", C,
     "function addIssuer(address key, string calldata name) external onlyOwner", "function addIssuer(address key, string calldata name) external", T),
    ("anyone can report a compromise", C,
     "function reportCompromise(uint32 id, uint64 since, address newKey) external onlyOwner", "function reportCompromise(uint32 id, uint64 since, address newKey) external", T),
    ("a suspended institution can still issue", C,
     "if (!s.active) revert IssuerSuspended(id);", "", T),
    ("a serial can be overwritten (forger replaces a real record)", C,
     "if (r.time != 0 && !_distrusted(id, r.time, r.blockNo)) revert AlreadyIssued(serial);", "", T),
    ("verify ignores the document hash", C,
     "if (r.time == 0 || r.docHash != docHash) return (Status.Unknown, 0, 0);", "if (r.time == 0) return (Status.Unknown, 0, 0);", T),
    ("single leaf hash (inner node passes as a certificate)", C,
     "bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(b.issuerId, serial, docHash))));",
     "bytes32 leaf = keccak256(abi.encode(b.issuerId, serial, docHash));", T),
    ("issuer id not in the leaf (F-1: copied batches)", C,
     "abi.encode(b.issuerId, serial, docHash)", "abi.encode(uint32(1), serial, docHash)", T),
    ("one institution's serials shared by all (no namespace)", C,
     "return keccak256(abi.encode(issuerId, serial));", "return keccak256(abi.encode(uint32(0), serial));", T),
    ("anyone's batch can be revoked", C,
     "if (b.issuerId != id) revert NotYourBatch(batchId);", "", T),
    ("batch revocation ignored by verify", C,
     "if (_trustedRevocation(issuerId, br)) return (Status.Revoked, time, br.reason);", "", T),
    ("thief's revocations still count", C,
     "return rv.time != 0 && !_distrusted(issuerId, rv.time, rv.blockNo);", "return rv.time != 0;", T),
    ("compromise window ignores the start time", C,
     "if (time >= ws[i].since && blockNo <= ws[i].untilBlock) return true;", "if (blockNo <= ws[i].untilBlock) return true;", T),
    ("new key may act in the report block", C,
     "s.keyActiveFrom = uint64(block.number + 1);", "s.keyActiveFrom = uint64(block.number);", T),
    ("old key not removed on rotation", C,
     "delete issuerOfKey[old];", "", T),
    ("no lookback limit for the council", C,
     "|| since + MAX_LOOKBACK < block.timestamp", "", T),
    ("too many reports refused (F-2)", C,
     "Window storage last = ws[ws.length - 1];", "revert(); Window storage last = ws[ws.length - 1];", T),
    ("council may renounce (F-3)", C,
     "revert RenounceDisabled();", "_transferOwnership(address(0));", T),
    ("retired keys may come back (F-4)", C,
     "retiredKey[old] = true;", "", T),
    ("salt left out of the document hash", L,
     "[issuerId, ...values, salt]", "[issuerId, ...values, \"0x\" + \"00\".repeat(32)]", LT),
    ("no Unicode normalisation", L,
     'return value.normalize("NFC").trim()', "return value.trim()", LT),
    ("fields concatenated instead of abi.encode", L,
     'return keccak256(coder.encode(["uint32", ...FIELDS.map(() => "string"), "bytes32"], [issuerId, ...values, salt]));',
     'return keccak256(toUtf8Bytes(issuerId + values.join("") + salt));', LT),
    ("duplicate serials allowed in a batch", L,
     "if (seen.has(serial)) throw new Error(`duplicate serial in batch: ${serial}`);", "", LT),
    # ── Day 29: web app ──
    ("verifier trusts the institution id in the QR (F-5)", V,
     "if (Number(batchIssuer) !== p.issuerId) {", "if (false) {", E),
    ("verifier writes QR text as HTML (XSS)", V,
     "tr.insertCell().textContent = v;", "tr.insertCell().innerHTML = v;", E),
    ("forged certificate's claimed details are shown", V,
     'if (name !== "Unknown") {', "if (true) {", E),
    ("RPC outage reported as a fake certificate", V,
     'show("error", "COULD NOT CHECK"', 'show("unknown", "NOT FOUND"', E),
    ("no warning for a QR that points to another website", V,
     "if (host !== location.host) {", "if (false) {", E),
    ("publish allowed before the salts are backed up", PO,
     "!prepared || !backupSaved;", "!prepared;", E),
    ("double click publishes twice", PO,
     "busy = true; // one click = one transaction", "// one click = one transaction", E),
    ("rebuilt pack not checked against the chain", PO,
     "if (root !== tree.root ||", "if (false) if (root !== tree.root ||", E),
    ("wrong network not detected", CH,
     "rightChain: chainId === cfg.chainId", "rightChain: true", E),
    ("duplicate certificate numbers allowed in the CSV", CO,
     "if (cert.certNo && seen.has(key)) errors.push", "if (false) errors.push", AT),
    ("spreadsheet formulas left live in the pack (CSV injection)", CO,
     "if (/^[=+\\-@\\t\\r]/.test(s)) s = \"'\" + s;", "", AT),
    ("salt of any length accepted from a QR", CO,
     'if (b.length !== 32) throw new Error("expected 32 bytes");', "", AT),
    ("server answers any Host (DNS rebinding)", SV,
     'if (!allowedHost.test(req.headers.host || "")) return send(403, "forbidden host");', "", E),
    ("server serves files outside public/ (path traversal)", SV,
     "!file.startsWith(PUBLIC + path.sep) || ", "", E),
]


def run(test):
    r = subprocess.run(["npx", "hardhat", "test", test], cwd=ROOT, capture_output=True, text=True, timeout=600)
    return r.returncode != 0


def main():
    caught = 0
    for i, (name, f, old, new, test) in enumerate(BUGS, 1):
        p = ROOT / f
        src = p.read_text()
        if src.count(old) != 1:
            print(f"{i:2}. {name}: PATTERN NOT FOUND in {f}")
            sys.exit(2)
        p.write_text(src.replace(old, new))
        try:
            ok = run(test)
        finally:
            p.write_text(src)
        caught += ok
        print(f"{i:2}. {'CAUGHT ' if ok else 'MISSED '} {name}", flush=True)
    print(f"\n{caught} of {len(BUGS)} planted bugs caught")
    sys.exit(0 if caught == len(BUGS) else 1)


if __name__ == "__main__":
    main()
