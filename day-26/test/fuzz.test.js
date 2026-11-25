// Fuzzing with fast-check on the two real chains.
//  1. Tampering: change any one field of a validly signed message → it is always refused.
//  2. Sequences: random sends both ways, relays, mined blocks and replays → every
//     message is delivered exactly once, in order, to the right (chain, sender) list.
const { expect } = require("chai");
const fc = require("fast-check");
const { ethers } = require("ethers");
const h = require("./helpers");
const { createValidator, createRelayer } = require("../relayer/relayer");

const RUNS_TAMPER = 150;
const RUNS_SEQ = 30;

describe("Day 26 — fuzzing", function () {
  this.timeout(600000);
  let env, snap;
  const stats = { tamper: 0, refused: 0, commands: 0, delivered: 0, replays: 0 };

  before(async () => { env = await h.setup(18745, 18746); });
  after(async () => {
    await env?.chains.stop();
    console.log(`      fuzz: ${stats.tamper} tamperings → ${stats.refused} refused; ${RUNS_SEQ} sequences, ${stats.commands} commands, ${stats.delivered} deliveries, ${stats.replays} replays refused`);
  });
  beforeEach(async () => { snap = await h.snapshot(env); });
  afterEach(async () => { await h.revert(env, snap); });

  it(`${RUNS_TAMPER} random one-field tamperings of a signed message are all refused`, async () => {
    const { message } = await h.send(env, "l1", env.user.l1, { data: h.encodeText("Buy momo") });
    const sigs = await h.sign(message, env.validators.slice(0, 2));
    await env.l2.messenger.receiveMessage.staticCall(message, sigs); // the untouched message is valid
    const fields = ["srcChainId", "srcMessenger", "dstChainId", "dstMessenger", "nonce", "sender", "target", "data"];
    const addr = fc.uint8Array({ minLength: 20, maxLength: 20 }).map((b) => ethers.getAddress(ethers.hexlify(b)));
    const value = {
      srcChainId: fc.oneof(fc.constant(31338n), fc.bigUint(2n ** 64n)), dstChainId: fc.oneof(fc.constant(31337n), fc.bigUint(2n ** 64n)),
      nonce: fc.bigUint(2n ** 64n), srcMessenger: addr, dstMessenger: addr, sender: addr, target: addr,
      data: fc.string({ maxLength: 40 }).map(h.encodeText),
    };
    await fc.assert(fc.asyncProperty(
      fc.constantFrom(...fields).chain((f) => fc.tuple(fc.constant(f), value[f])),
      async ([field, v]) => {
        const changed = { ...message, [field]: v };
        fc.pre(String(changed[field]).toLowerCase() !== String(message[field]).toLowerCase());
        stats.tamper++;
        let refused = false;
        try { await env.l2.messenger.receiveMessage.staticCall(changed, sigs); } catch { refused = true; }
        if (refused) stats.refused++;
        expect(refused, `tampered ${field}`).to.equal(true);
      },
    ), { numRuns: RUNS_TAMPER });
  });

  it(`${RUNS_SEQ} random sequences: every message delivered exactly once, in order`, async () => {
    const mk = (from, to) => createRelayer({
      src: env.chains[from], dst: env.chains[to], srcMessenger: env[from].address.messenger, dstMessenger: env[to].address.messenger,
      threshold: 2, submitterKey: env.submitterKey, confirmations: 2,
      validators: env.validators.map((v) => createValidator({ privateKey: v.privateKey, src: env.chains[from], srcMessenger: env[from].address.messenger, dstChainId: env.chains[to].chainId, dstMessenger: env[to].address.messenger, confirmations: 2 })),
    });
    const cmd = fc.oneof(
      fc.record({ op: fc.constant("send"), from: fc.constantFrom("l1", "l2"), user: fc.constantFrom(1, 2), text: fc.string({ minLength: 1, maxLength: 20 }) }),
      fc.record({ op: fc.constant("poll"), from: fc.constantFrom("l1", "l2") }),
      fc.record({ op: fc.constant("mine"), from: fc.constantFrom("l1", "l2") }),
      fc.record({ op: fc.constant("replay") }),
    );
    await fc.assert(fc.asyncProperty(fc.array(cmd, { minLength: 3, maxLength: 12 }), async (cmds) => {
      const ids = await h.snapshot(env);
      try {
        const relayers = { l1: mk("l1", "l2"), l2: mk("l2", "l1") };
        const model = { l1: [], l2: [] }; // messages sent FROM each chain, in order
        for (const c of cmds) {
          stats.commands++;
          if (c.op === "send") {
            const w = h.devWallet(c.user, env.chains[c.from].provider);
            const text = c.text;
            const { message } = await h.send(env, c.from, w, { data: h.encodeText(text) });
            model[c.from].push({ user: w.address, text, message });
          } else if (c.op === "poll") {
            for (const r of await relayers[c.from].poll()) {
              expect(r.status).to.not.equal("failed");
              if (r.status === "delivered") stats.delivered++;
            }
          } else if (c.op === "mine") {
            await h.mine(env.chains[c.from], 1);
          } else if (model.l1.length || model.l2.length) { // replay an earlier message
            const all = [...model.l1, ...model.l2];
            const pick = all[stats.commands % all.length].message;
            const to = pick.dstChainId === 31338n ? "l2" : "l1";
            const sigs = await h.sign(pick, env.validators.slice(0, 2));
            if (await env[to].messenger.processed(h.hashMessage(pick))) {
              let refused = false;
              try { await env[to].messenger.receiveMessage.staticCall(pick, sigs); } catch { refused = true; }
              expect(refused).to.equal(true);
              stats.replays++;
            }
          }
        }
        // finish: confirm and relay everything, then check against the model
        await h.mine(env.chains.l1, 2); await h.mine(env.chains.l2, 2);
        for (const r of [...await relayers.l1.poll(), ...await relayers.l2.poll()]) if (r.status === "delivered") stats.delivered++;
        // every message sent is now delivered, and replaying any of them is refused
        for (const { message } of [...model.l1, ...model.l2]) {
          const to = message.dstChainId === 31338n ? "l2" : "l1";
          expect(await env[to].messenger.processed(h.hashMessage(message))).to.equal(true);
          let refused = false;
          try { await env[to].messenger.receiveMessage.staticCall(message, await h.sign(message, env.validators.slice(1))); } catch { refused = true; }
          expect(refused).to.equal(true);
          stats.replays++;
        }
        for (const [from, to, srcId] of [["l1", "l2", 31337], ["l2", "l1", 31338]]) {
          for (const u of [1, 2]) {
            const addr = h.devWallet(u, env.chains[from].provider).address;
            const want = model[from].filter((m) => m.user === addr).map((m) => m.text);
            const got = (await env[to].todo.getTasks(srcId, addr)).map((t) => t.text);
            expect(got).to.deep.equal(want);
            expect(await env[to].todo.getTasks(env.chains[to].chainId, addr)).to.have.length(0); // never mixed into local lists
          }
        }
      } finally { await h.revert(env, ids); }
    }), { numRuns: RUNS_SEQ });
  });
});
