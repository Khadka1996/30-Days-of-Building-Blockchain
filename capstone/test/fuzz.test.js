// Property tests with fast-check: random batches, and random key-theft timelines checked
// against what really happened (who made each record: the institution or the thief).
const { expect } = require("chai");
const fc = require("fast-check");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { S, cert, deployFixture } = require("./helpers");
const { buildBatch, docHashOf } = require("../lib/pramaan");

const DAY = 86400;

describe("Fuzz — batches", function () {
  it("every member verifies, every tampered or foreign certificate reads Unknown (60 random batches)", async function () {
    let checks = 0;
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 120 }), fc.integer({ min: 0, max: 1e6 }), fc.nat(), async (size, start, pick) => {
        const { p, neb } = await loadFixture(deployFixture);
        const certs = Array.from({ length: size }, (_, i) => cert(start + i));
        const tree = buildBatch(1, certs);
        await p.connect(neb).issueBatch(tree.root, size);
        const c = certs[pick % size];
        const proof = tree.proof(c.serial, c.docHash);
        expect((await p.verifyInBatch(1, c.serial, c.docHash, proof))[0]).to.equal(S.Valid);
        const tampered = docHashOf(1, { ...c.cert, result: c.cert.result + "+" }, c.salt);
        expect((await p.verifyInBatch(1, c.serial, tampered, proof))[0]).to.equal(S.Unknown);
        const outsider = cert(start + size + 1);
        expect((await p.verifyInBatch(1, outsider.serial, outsider.docHash, proof))[0]).to.equal(S.Unknown);
        checks += 3;
      }),
      { numRuns: 60 },
    );
    console.log(`      ${checks} batch checks, 0 wrong`);
  });
});

describe("Fuzz — stolen key timelines", function () {
  // One step: issue a certificate or revoke an earlier one, after some hours.
  const step = fc.record({ revoke: fc.boolean(), hours: fc.integer({ min: 1, max: 72 }) });

  it("after the report the thief's work is never trusted and real work before the theft is never harmed (40 random timelines)", async function () {
    let records = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(step, { minLength: 1, maxLength: 8 }), // the institution, before the theft
        fc.array(step, { minLength: 1, maxLength: 8 }), // the thief, with the same key
        fc.integer({ min: 0, max: 20 }), // the council sets `since` this many days before the real theft
        async (before, during, early) => {
          const { p, neb, nebNew, NEB } = await loadFixture(deployFixture);
          const made = []; // { c, phase }
          const revokedIn = new Map(); // serial -> phase of the revocation
          let n = 0;
          const run = async (steps, phase) => {
            for (const a of steps) {
              await time.increase(a.hours * 3600);
              const target = made.find((m) => !revokedIn.has(m.c.serial));
              if (a.revoke && target) {
                await p.connect(neb).revoke(target.c.serial, 1);
                revokedIn.set(target.c.serial, phase);
              } else {
                const c = cert(++n);
                await p.connect(neb).issue(c.serial, c.docHash);
                made.push({ c, phase });
              }
            }
          };
          await run(before, "real");
          await time.increase(DAY);
          const theft = await time.latest();
          await run(during, "thief");
          await time.increase(DAY);
          await p.reportCompromise(NEB, theft - early * DAY, nebNew.address);

          for (const m of made) {
            const [st] = await p.verify(NEB, m.c.serial, m.c.docHash);
            records++;
            // 1. Anything the stolen key published is never Valid.
            if (m.phase === "thief") expect(st, "thief's certificate").to.equal(S.Distrusted);
            // 2. The thief's revocations never count: a real certificate is never Revoked by the thief.
            if (m.phase === "real" && revokedIn.get(m.c.serial) === "thief") expect(st).to.not.equal(S.Revoked);
            // 3. With an exact `since`, real work before the theft is exactly as the institution left it.
            if (m.phase === "real" && early === 0) {
              expect(st).to.equal(revokedIn.get(m.c.serial) === "real" ? S.Revoked : S.Valid);
            }
            // 4. A real certificate never disappears (Unknown): at worst Distrusted, and re-issuable.
            if (m.phase === "real") expect(st).to.not.equal(S.Unknown);
          }
          // 5. Distrusted certificates can be re-issued and the new key works.
          for (const m of made.filter((x) => x.phase === "real")) {
            if ((await p.verify(NEB, m.c.serial, m.c.docHash))[0] === S.Distrusted) {
              await p.connect(nebNew).issue(m.c.serial, m.c.docHash);
              expect((await p.verify(NEB, m.c.serial, m.c.docHash))[0]).to.equal(S.Valid);
            }
          }
          const fresh = cert(++n);
          await p.connect(nebNew).issue(fresh.serial, fresh.docHash);
          expect((await p.verify(NEB, fresh.serial, fresh.docHash))[0]).to.equal(S.Valid);
        },
      ),
      { numRuns: 40 },
    );
    console.log(`      ${records} records checked against who really made them`);
  });
});
