// Property tests (fast-check). Two promises the server must keep, whatever the input:
//   1. A signature is only accepted for the EXACT text that was signed.
//   2. Random fields (domain, URI, chain, nonce, times) are accepted only when
//      every single one is right — checked against a tiny reference model.
const { expect } = require("chai");
const fc = require("fast-check");
const h = require("./helpers");

describe("Day 24 — fuzzing the login", function () {
  this.timeout(300000);
  let env, app, snap;
  const stats = { mutated: 0, fieldCombos: 0, accepted: 0, replays: 0 };

  before(async () => {
    snap = await h.snapshot();
    env = await h.deploy();
    app = await h.startServer(env);
  });
  after(async () => {
    await app.close();
    await h.revert(snap);
    console.log(`      fuzz stats: ${JSON.stringify(stats)}`);
  });

  it("any edit to a signed message (insert, delete or change a character) is refused", async () => {
    const signer = env.signers[0];
    await fc.assert(
      fc.asyncProperty(
        fc.nat(), // position
        fc.constantFrom("insert", "delete", "replace"),
        fc.oneof(fc.char(), fc.constantFrom("\n", " ", "0", "a", "A", ":", "/")),
        async (pos, op, ch) => {
          const b = new h.Browser(app.base);
          const { json } = await b.nonce();
          const good = h.buildMessage(app, signer.address, json.nonce);
          const sig = await signer.signMessage(good);
          const i = pos % good.length;
          const bad = op === "insert" ? good.slice(0, i) + ch + good.slice(i)
            : op === "delete" ? good.slice(0, i) + good.slice(i + 1)
            : good.slice(0, i) + ch + good.slice(i + 1);
          fc.pre(bad !== good);
          stats.mutated++;
          const res = await b.login(bad, sig);
          expect(res.status, `${op}@${i} ${JSON.stringify(ch)} → ${res.json?.error}`).to.equal(401);
          // ...and the nonce is now burned, so even the genuine text fails afterwards.
          expect((await b.login(good, sig)).status).to.equal(401);
          stats.replays++;
        },
      ),
      { numRuns: 150 },
    );
  });

  it("random field combinations: accepted if and only if every field is right", async () => {
    const signer = env.signers[2];
    const host = new URL(app.base).host;
    const MIN = 60 * 1000;
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          // the right value is listed several times so that ~1 in 4 runs is fully valid
          domain: fc.constantFrom(host, host, host, host, host, host, "evil.example", `localhost:${new URL(app.base).port}`, "127.0.0.1"),
          uri: fc.constantFrom(app.base, app.base, app.base, app.base, `${app.base}/login`, `${app.base}/login`, "https://evil.example", "http://127.0.0.1:1"),
          chainId: fc.constantFrom(h.CHAIN_ID, h.CHAIN_ID, h.CHAIN_ID, h.CHAIN_ID, 1, 31338),
          nonceKind: fc.constantFrom("mine", "mine", "mine", "mine", "mine", "other", "random"),
          // steps of 10 s, offset by 5 s, so no value sits exactly on a limit (no flaky ms races)
          issuedOffset: fc.integer({ min: -48, max: 24 }).map((x) => x * 10000 + 5000),
          expOffset: fc.option(fc.integer({ min: -12, max: 180 }).map((x) => x * 10000 + 5000), { nil: undefined }),
        }),
        async (f) => {
          const now = Date.now();
          const b = new h.Browser(app.base);
          const mine = (await b.nonce()).json.nonce;
          const other = (await new h.Browser(app.base).nonce()).json.nonce;
          const nonce = f.nonceKind === "mine" ? mine : f.nonceKind === "other" ? other : "f".repeat(32);
          const issuedAt = new Date(now + f.issuedOffset);
          const expirationTime = f.expOffset === undefined ? undefined : new Date(now + f.expOffset);
          const message = h.buildMessage(app, signer.address, nonce, { domain: f.domain, uri: f.uri, chainId: f.chainId, issuedAt, expirationTime });
          const res = await b.login(message, await signer.signMessage(message));

          // Reference model: what SHOULD happen (60 s clock skew, 5 min max age).
          const expected =
            f.domain === host && new URL(f.uri).origin === app.base && f.chainId === h.CHAIN_ID && f.nonceKind === "mine" &&
            f.issuedOffset <= MIN && f.issuedOffset >= -5 * MIN &&
            (f.expOffset === undefined || (f.expOffset > 0 && f.expOffset > f.issuedOffset));
          stats.fieldCombos++;
          if (expected) stats.accepted++;
          expect(res.status === 200, `${JSON.stringify(f)} → ${res.status} ${res.json?.error || ""}`).to.equal(expected);
        },
      ),
      { numRuns: 400 },
    );
    expect(stats.accepted).to.be.greaterThan(0); // the property must exercise the "yes" side too
  });
});
