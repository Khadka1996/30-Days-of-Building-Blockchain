// Fuzz tests (fast-check): random tampering, and random sequences of good and bad
// requests checked against a tiny model of what SHOULD happen.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const fc = require("fast-check");
const h = require("./helpers");

describe("Day 25 — fuzzing the forwarder and relayer", function () {
  this.timeout(300000);
  let env, app, snap;
  const stats = { tampered: 0, sequences: 0, commands: 0, relayed: 0, refused: 0 };

  before(async () => {
    snap = await h.snapshot();
    env = await h.deploy();
    app = await h.startRelayer(env, { limits: { ratePerMinute: 10_000 } });
  });
  after(async () => {
    await app.close(); await h.revert(snap);
    console.log("      fuzz stats:", JSON.stringify(stats));
  });

  it("any change to a signed request (any field, or the signature) is refused, and costs the relayer nothing", async () => {
    const user = h.newUser();
    const base = await h.signRequest(env, user, { args: ["original"] });
    const txBefore = await h.txCount(app.relayerAddress);
    const other = ethers.Wallet.createRandom().address;

    const tamper = fc.oneof(
      fc.record({ field: fc.constant("from"), v: fc.constant(other) }),
      fc.record({ field: fc.constant("to"), v: fc.constantFrom(other, env.forwarderInfo.address) }),
      fc.record({ field: fc.constant("gas"), v: fc.bigInt({ min: 1n, max: 300_000n }) }),
      fc.record({ field: fc.constant("nonce"), v: fc.bigInt({ min: 1n, max: 2n ** 64n }) }),
      fc.record({ field: fc.constant("deadline"), v: fc.integer({ min: 1, max: 1000 }) }),          // added to deadline
      fc.record({ field: fc.constant("data"), v: fc.integer({ min: 0, max: 1000 }) }),              // which byte to flip
      fc.record({ field: fc.constant("signature"), v: fc.integer({ min: 0, max: 63 }) }),           // which r/s byte to flip
    );

    await fc.assert(fc.asyncProperty(tamper, async ({ field, v }) => {
      const req = { ...base.req };
      let signature = base.signature;
      if (field === "deadline") req.deadline = base.req.deadline + v;
      else if (field === "data") {
        const b = ethers.getBytes(req.data); const i = v % b.length; b[i] ^= 0x01; req.data = ethers.hexlify(b);
      } else if (field === "signature") {
        const b = ethers.getBytes(signature); b[v] ^= 0x01; signature = ethers.hexlify(b);
      } else req[field] = v;
      stats.tampered++;
      expect(await env.forwarder.verify(req, signature), field).to.equal(false);
      const r = await app.post(h.toJson({ req, signature }));
      expect(r.status, `${field}: ${r.body.error}`).to.be.oneOf([400, 401, 403]);
    }), { numRuns: 150 });

    expect(await h.txCount(app.relayerAddress)).to.equal(txBefore); // not one paid transaction
    expect(await env.forwarder.verify(base.req, base.signature)).to.equal(true); // the original still works
  });

  it("random sequences of good, replayed, out-of-order, expired and failing requests match the model", async () => {
    const kinds = ["good", "good", "good", "replay", "future", "expired", "failing", "otherNonceTwin"];
    const command = fc.record({ who: fc.integer({ min: 0, max: 1 }), kind: fc.constantFrom(...kinds) });

    await fc.assert(fc.asyncProperty(fc.array(command, { minLength: 1, maxLength: 10 }), async (cmds) => {
      stats.sequences++;
      const users = [h.newUser(), h.newUser()];
      const model = users.map(() => ({ nonce: 0n, tasks: 0n, used: [] }));
      const txBefore = await h.txCount(app.relayerAddress);
      let accepted = 0;

      for (const { who, kind } of cmds) {
        stats.commands++;
        const u = users[who], m = model[who];
        let s, shouldPass = false;
        if (kind === "good") { s = await h.signRequest(env, u, { args: [`t${m.nonce}`] }); shouldPass = true; }
        else if (kind === "replay") { if (!m.used.length) continue; s = m.used[m.used.length - 1]; }
        else if (kind === "future") s = await h.signRequest(env, u, { nonce: m.nonce + 1n });
        else if (kind === "expired") s = await h.signRequest(env, u, { deadline: (await h.chainNow()) - 1 });
        else if (kind === "failing") s = await h.signRequest(env, u, { args: [""] });
        else if (kind === "otherNonceTwin") {
          // a different request signed with an ALREADY USED nonce
          if (m.nonce === 0n) continue;
          s = await h.signRequest(env, u, { nonce: m.nonce - 1n, args: ["twin"] });
        }
        const r = await app.post(h.toJson(s));
        if (shouldPass) {
          expect(r.status, `${kind}: ${r.body.error}`).to.equal(200);
          m.nonce++; m.tasks++; m.used.push(s); accepted++; stats.relayed++;
        } else {
          expect(r.status, kind).to.not.equal(200);
          stats.refused++;
        }
      }
      for (let i = 0; i < users.length; i++) {
        expect(await env.forwarder.nonces(users[i].address)).to.equal(model[i].nonce);
        expect(await env.todo.taskCount(users[i].address)).to.equal(model[i].tasks);
      }
      // The relayer paid for exactly the accepted requests: never for a refused one.
      expect((await h.txCount(app.relayerAddress)) - txBefore).to.equal(accepted);
    }), { numRuns: 40 });
  });
});
