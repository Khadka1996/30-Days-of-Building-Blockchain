// Day 29 — the web app's pure code: the QR payload and the CSV reader/writer (unit + fuzz).
const { expect } = require("chai");
const fc = require("fast-check");
const { buildBatch, FIELDS } = require("../lib/pramaan");
const C = require("../app/src/codec");
const { cert } = require("./helpers");

function payloadFor(n, over = {}) {
  const c = cert(n, over);
  const tree = buildBatch(c.issuerId, [c, cert(n + 1), cert(n + 2)]);
  return { c, p: { issuerId: c.issuerId, batchId: 7, cert: c.cert, salt: c.salt, proof: tree.proof(c.serial, c.docHash) } };
}

describe("Day 29 — QR payload", () => {
  it("round-trips and recomputes the same serial and docHash", () => {
    const { c, p } = payloadFor(1, { name: "सीता कुमारी यादव" });
    const back = C.decodePayload(C.encodePayload(p));
    expect(back).to.deep.equal(p);
    expect(C.checkInputs(back)).to.deep.equal({ serial: c.serial, docHash: c.docHash });
  });

  it("fits in a scannable QR code even for a 10,000-certificate batch (14-hash proof)", () => {
    const { p } = payloadFor(1, { name: "A".repeat(40) });
    const link = C.verifyLink("https://pramaan.example.np", C.encodePayload({ ...p, proof: Array(14).fill(p.salt) }));
    expect(link.length).to.be.below(1300); // QR version ≤ 27 at error level M
  });

  it("reads the payload from a full link, a link with a path, or a bare payload; refuses anything else", () => {
    const enc = C.encodePayload(payloadFor(1).p);
    expect(C.payloadFromLink(`https://x.np/verify.html#c=${enc}`)).to.equal(enc);
    expect(C.payloadFromLink(`  ${enc}\n`)).to.equal(enc);
    expect(() => C.payloadFromLink("https://evil.example/login")).to.throw();
    expect(() => C.payloadFromLink("javascript:alert(1)")).to.throw();
  });

  it("rejects wrong versions, bad ids, wrong salt length, long fields, long proofs and garbage", () => {
    const { p } = payloadFor(1);
    const raw = JSON.parse(Buffer.from(C.encodePayload(p), "base64url").toString());
    const enc = (a) => Buffer.from(JSON.stringify(a)).toString("base64url");
    const bad = [
      [2, ...raw.slice(1)],
      [1, 0, ...raw.slice(2)],
      [1, 2 ** 32, ...raw.slice(2)],
      [1, raw[1], 0, ...raw.slice(3)],
      [1, raw[1], 1.5, ...raw.slice(3)],
      [1, raw[1], raw[2], raw[3].slice(0, 5), raw[4], raw[5]],
      [1, raw[1], raw[2], [...raw[3].slice(0, 5), ""], raw[4], raw[5]],
      [1, raw[1], raw[2], [...raw[3].slice(0, 5), "x".repeat(C.MAX_FIELD + 1)], raw[4], raw[5]],
      [1, raw[1], raw[2], [...raw[3].slice(0, 5), 7], raw[4], raw[5]],
      [1, raw[1], raw[2], raw[3], raw[4].slice(0, 20), raw[5]],
      [1, raw[1], raw[2], raw[3], raw[4], Array(C.MAX_PROOF + 1).fill(raw[4])],
      { a: 1 },
    ];
    for (const b of bad) expect(() => C.decodePayload(enc(b)), JSON.stringify(b).slice(0, 60)).to.throw();
    for (const g of ["", "!!!", "a", "x".repeat(C.MAX_PAYLOAD + 1), Buffer.from([0xff, 0xfe]).toString("base64url")]) expect(() => C.decodePayload(g)).to.throw();
  });

  it("fuzz: random certificates round-trip; random strings never decode to something half-valid", () => {
    const field = fc.string({ minLength: 1, maxLength: 60, unit: "grapheme" }).filter((s) => s.trim().replace(/\s+/g, " ").normalize("NFC").length > 0);
    fc.assert(
      fc.property(fc.array(field, { minLength: 6, maxLength: 6 }), fc.integer({ min: 1, max: 2 ** 32 - 1 }), fc.integer({ min: 1, max: 1e12 }), (vals, issuerId, batchId) => {
        const { p } = payloadFor(1);
        const c = Object.fromEntries(FIELDS.map((f, i) => [f, vals[i]]));
        const q = { ...p, issuerId, batchId, cert: c };
        const back = C.decodePayload(C.encodePayload(q));
        expect(back.issuerId).to.equal(issuerId);
        expect(back.batchId).to.equal(batchId);
        for (const f of FIELDS) expect(back.cert[f]).to.equal(c[f].normalize("NFC").trim().replace(/\s+/g, " "));
      }),
      { numRuns: 200 },
    );
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (s) => {
        try {
          const r = C.decodePayload(s);
          expect(r.salt).to.match(/^0x[0-9a-f]{64}$/); // if it ever decodes, it is fully well-formed
        } catch (e) {
          expect(e).to.be.instanceOf(Error);
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe("Day 29 — results CSV", () => {
  const HEAD = FIELDS.join(",");

  it("reads quotes, commas, new lines inside quotes, CRLF, a BOM and Devanagari", () => {
    const text = `﻿${HEAD}\r\nA-1,"Gurung, Pema ""Lhamu""",2065-01-19,"SEE\nRegular",GPA 2.90,2081-03-15\r\nA-2,सीता यादव,2064-11-02,SEE,GPA 3.65,2081-03-15\r\n`;
    const { certs, errors } = C.readResults(text);
    expect(errors).to.deep.equal([]);
    expect(certs.map((c) => c.name)).to.deep.equal(['Gurung, Pema "Lhamu"', "सीता यादव"]);
    expect(certs[0].program).to.equal("SEE Regular"); // cleaned: one space
  });

  it("accepts the columns in any order", () => {
    const { certs, errors } = C.readResults(`name,certNo,dateOfBirth,program,result,issuedOn\nRam,X-1,2065-01-01,SEE,GPA 3,2081-03-15\n`);
    expect(errors).to.deep.equal([]);
    expect(certs[0]).to.include({ certNo: "X-1", name: "Ram" });
  });

  it("refuses missing columns, empty cells, wrong cell counts, long fields, duplicate numbers, unclosed quotes", () => {
    expect(C.readResults("certNo,name\nA,B\n").errors[0]).to.match(/missing column/);
    const r = C.readResults(`${HEAD}\nA-1,,2065,SEE,GPA,2081\nA-2,Ram,2065,SEE\nA-3,${"x".repeat(201)},2065,SEE,GPA,2081\nA-4,Sita,2065,SEE,GPA,2081\na-4,Gita,2065,SEE,GPA,2081\n`);
    expect(r.errors.join(" | ")).to.match(/line 2: name is empty/).and.match(/line 3: 4 cells/).and.match(/line 4: name is longer/).and.match(/line 6: certificate number a-4 is also on line 5/);
    expect(C.readResults(`${HEAD}\n"A-1,Ram,2065,SEE,GPA,2081\n`).errors[0]).to.match(/unclosed quote/);
    expect(C.readResults("").errors[0]).to.match(/empty/);
    expect(C.readResults(`${HEAD}\n`).errors[0]).to.match(/no certificates/);
  });

  it(`refuses more than ${C.MAX_ROWS} rows in one upload`, () => {
    const big = HEAD + "\n" + Array.from({ length: C.MAX_ROWS + 1 }, (_, i) => `N-${i},Ram,2065,SEE,GPA,2081`).join("\n");
    expect(C.readResults(big).errors[0]).to.match(/at most 20000/);
  });

  it("pack CSV: cells that a spreadsheet would run as a formula are made harmless", () => {
    expect(C.csvCell('=HYPERLINK("http://evil","click")')).to.equal(`"'=HYPERLINK(""http://evil"",""click"")"`);
    for (const s of ["+1", "-1+1", "@SUM(A1)", "\tx"]) expect(C.csvCell(s).replace(/^"/, "")[0]).to.equal("'");
    expect(C.csvCell("Ram Thapa")).to.equal("Ram Thapa");
  });

  it("fuzz: anything written by toCsv is read back exactly (quotes, commas, new lines, Unicode)", () => {
    const cellArb = fc.string({ minLength: 1, maxLength: 30, unit: "grapheme" }).filter((s) => !/^[=+\-@\t\r]/.test(s));
    fc.assert(
      fc.property(fc.array(fc.array(cellArb, { minLength: 3, maxLength: 3 }), { minLength: 1, maxLength: 20 }), (rows) => {
        expect(C.parseCsv(C.toCsv(rows))).to.deep.equal(rows);
      }),
      { numRuns: 300 },
    );
  });
});
