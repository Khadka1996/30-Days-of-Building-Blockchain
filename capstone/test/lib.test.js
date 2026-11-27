const { expect } = require("chai");
const { ethers } = require("hardhat");
const { serialOf, docHashOf, buildBatch, newSalt } = require("../lib/pramaan");
const { cert } = require("./helpers");

describe("lib/pramaan.js — hashing a certificate", function () {
  const base = cert(1).cert;
  const salt = newSalt();

  it("the same printed text always gives the same hash (Unicode NFC, spaces)", function () {
    // "क़" can be typed as one code point (U+0958) or as क + nukta (U+0915 U+093C): different bytes, same name.
    const composed = { ...base, name: "\u0958amal" };
    const decomposed = { ...base, name: "\u0915\u093Camal" };
    expect(composed.name).to.not.equal(decomposed.name);
    expect(docHashOf(1, composed, salt)).to.equal(docHashOf(1, decomposed, salt));
    expect(docHashOf(1, { ...base, name: "  Student   1 " }, salt)).to.equal(docHashOf(1, base, salt));
  });

  it("moving text between fields changes the hash (abi.encode, not plain concatenation)", function () {
    // Glued together, both read "...MBBSPass...": a forger could move letters between fields.
    const a = { ...base, program: "MBBS", result: "Pass" };
    const b = { ...base, program: "MBB", result: "SPass" };
    expect(docHashOf(1, a, salt)).to.not.equal(docHashOf(1, b, salt));
  });

  it("the issuer, the salt and every field are inside the hash", function () {
    const h = docHashOf(1, base, salt);
    expect(docHashOf(2, base, salt)).to.not.equal(h);
    expect(docHashOf(1, base, newSalt())).to.not.equal(h);
    for (const f of Object.keys(base)) expect(docHashOf(1, { ...base, [f]: base[f] + "x" }, salt)).to.not.equal(h);
  });

  it("refuses incomplete input", function () {
    expect(() => docHashOf(1, { ...base, result: " " }, salt)).to.throw("missing field: result");
    expect(() => docHashOf(1, base, "0x1234")).to.throw("salt");
    expect(() => docHashOf(0, base, salt)).to.throw("issuerId");
    expect(() => serialOf("   ")).to.throw("empty");
  });

  it("serial ignores case and surrounding spaces of the certificate number", function () {
    expect(serialOf(" see-2081-000001 ")).to.equal(serialOf("SEE-2081-000001"));
  });

  it("a batch refuses duplicate serials and certificates that are not in it", function () {
    const a = cert(1);
    expect(() => buildBatch(1, [a, { ...cert(2), serial: a.serial }])).to.throw("duplicate serial");
    expect(() => buildBatch(1, [])).to.throw("empty");
    const t = buildBatch(1, [a]);
    expect(t.proof(a.serial, a.docHash)).to.deep.equal([]);
    expect(() => t.proof(a.serial, ethers.ZeroHash)).to.throw("not in this batch");
  });
});
