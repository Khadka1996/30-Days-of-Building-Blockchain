// Fuzz test with fast-check: random sequences of price moves, time jumps, deposits, mints, repays,
// withdrawals and liquidations by three users and one liquidator. A small JavaScript model predicts
// whether each action must succeed. After every action the system's invariants must hold.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const fc = require("fast-check");
const { E, USD, WAD, MIN_RATIO, baseFixture, value, healthy, seizeFor, closing, needed } = require("./helpers");

const RUNS = Number(process.env.FUZZ_RUNS || 40);
const MIN_DEBT = E(100);

async function world() {
  const f = await baseFixture();
  // Gita the liquidator owns a very safe vault, so she always has EUSD to burn.
  await f.engine.connect(f.gita).depositAndMint(E(300_000), { value: E(2000) });
  // Ram starts close to the edge (166.7%), Sita comfortable (400%), the third user with no vault.
  await f.engine.connect(f.ram).depositAndMint(E(12_000), { value: E(10) });
  await f.engine.connect(f.sita).depositAndMint(E(5_000), { value: E(10) });
  return f;
}

const user = fc.integer({ min: 0, max: 2 });
const action = fc.oneof(
  { weight: 2, arbitrary: fc.record({ t: fc.constant("price"), usd: fc.oneof(fc.integer({ min: 700, max: 1800 }), fc.integer({ min: 1800, max: 3000 })) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("stale") }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("deposit"), u: user, milli: fc.integer({ min: 1, max: 20_000 }) }) }, // up to 20 ETH
  { weight: 1, arbitrary: fc.record({ t: fc.constant("mint"), u: user, pct: fc.integer({ min: 1, max: 130 }) }) }, // % of what is allowed
  { weight: 1, arbitrary: fc.record({ t: fc.constant("repay"), u: user, pct: fc.integer({ min: 1, max: 110 }) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("withdraw"), u: user, pct: fc.integer({ min: 1, max: 110 }) }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("liquidate"), u: user, exact: fc.boolean(), pct: fc.integer({ min: 1, max: 120 }) }) },
);

async function ok(p) {
  try {
    await (await p).wait();
    return true;
  } catch {
    return false;
  }
}

describe("Fuzz: random vault activity keeps EUSD fully accounted for", function () {
  it(`${RUNS} random runs of up to 20 actions (model-predicted results + invariants)`, async function () {
    this.timeout(0);
    const seen = {};
    await fc.assert(
      fc.asyncProperty(fc.array(action, { minLength: 5, maxLength: 20, size: "max" }), async (actions) => {
        const f = await loadFixture(world);
        const { engine, eusd, feed, gita } = f;
        const users = [f.ram, f.sita, f.attacker];
        let px = E(2000);
        let fresh = true;

        for (const a of actions) {
          const s = a.u === undefined ? null : users[a.u];
          const v = s ? await engine.vaults(s.address) : null;
          let expectOk;
          let done;
          if (a.t === "price") {
            await feed.setPrice(USD(a.usd));
            px = E(a.usd);
            fresh = true;
            continue;
          } else if (a.t === "stale") {
            await time.increase(3601);
            fresh = false;
            continue;
          } else if (a.t === "deposit") {
            expectOk = true;
            done = await ok(engine.connect(s).deposit({ value: E(a.milli / 1000) }));
          } else if (a.t === "mint") {
            const room = (value(v.collateral, px) * WAD) / MIN_RATIO; // most debt allowed
            const amt = room > v.debt ? ((room - v.debt) * BigInt(a.pct)) / 100n + 1n : MIN_DEBT;
            const nd = v.debt + amt;
            expectOk = fresh && nd >= MIN_DEBT && healthy(v.collateral, nd, px);
            done = await ok(engine.connect(s).mint(amt));
            if (done) expect(healthy(v.collateral, nd, px), "minted into an unhealthy vault").to.equal(true);
          } else if (a.t === "repay") {
            const amt = (v.debt * BigInt(a.pct)) / 100n;
            const left = v.debt - amt;
            expectOk = amt > 0n && amt <= v.debt && (left === 0n || left >= MIN_DEBT);
            done = await ok(engine.connect(s).repay(amt));
          } else if (a.t === "withdraw") {
            const amt = (v.collateral * BigInt(a.pct)) / 100n;
            expectOk = amt > 0n && amt <= v.collateral && (v.debt === 0n || (fresh && healthy(v.collateral - amt, v.debt, px)));
            done = await ok(engine.connect(s).withdraw(amt));
          } else if (a.t === "liquidate") {
            const liquidatable = v.debt > 0n && !healthy(v.collateral, v.debt, px);
            const close = closing(v.collateral, v.debt, px);
            const lo = close ? needed(v.collateral, v.debt, px) : 1n; // least allowed repay
            const hi = close ? v.debt : v.debt / 2n; // most allowed repay
            // `exact`: the best amount (half, or exactly what is needed); otherwise 1–120% of the most
            const amt = a.exact ? (close ? lo : hi) : (hi * BigInt(a.pct)) / 100n;
            expectOk = fresh && liquidatable && amt > 0n && amt >= lo && amt <= hi;
            const before = await ethers.provider.getBalance(await engine.getAddress());
            const badBefore = await engine.badDebt();
            done = await ok(engine.connect(gita).liquidate(s.address, amt));
            if (done) {
              let seized = seizeFor(amt, px);
              if (close || seized > v.collateral) seized = v.collateral;
              const after = await ethers.provider.getBalance(await engine.getAddress());
              expect(before - after, "seized amount").to.equal(seized);
              // the liquidator never gets more than repay + 10% in value (1 wei of rounding allowed)
              expect(value(seized, px)).to.be.lte((amt * 11n) / 10n + 1n);
              // bad debt only appears when the ETH was worth less than the debt
              const bad = (await engine.badDebt()) - badBefore;
              if (value(v.collateral, px) >= v.debt) expect(bad, "avoidable bad debt").to.equal(0n);
              else expect(bad).to.equal(v.debt - amt);
            }
          }
          expect(done, `${JSON.stringify(a)} fresh=${fresh}`).to.equal(expectOk);
          seen[`${a.t} ${done ? "ok" : "refused"}`] = (seen[`${a.t} ${done ? "ok" : "refused"}`] || 0) + 1;
        }

        // Invariants
        let debts = 0n;
        let cols = 0n;
        for (const a of [...users, gita]) {
          const v = await engine.vaults(a.address);
          debts += v.debt;
          cols += v.collateral;
        }
        expect(await engine.totalDebt(), "totalDebt = sum of vault debts").to.equal(debts);
        expect(await eusd.totalSupply(), "supply = debts + written-off bad debt").to.equal(debts + (await engine.badDebt()));
        expect(await engine.totalCollateral(), "totalCollateral = sum of vault ETH").to.equal(cols);
        expect(await ethers.provider.getBalance(await engine.getAddress()), "ETH held = sum of collateral").to.equal(cols);
      }),
      { numRuns: RUNS },
    );
    // With enough runs (npm run fuzz), every kind of action must have both succeeded and been refused.
    if (process.env.FUZZ_STATS) console.log(seen);
    if (RUNS >= 100) for (const t of ["mint", "repay", "withdraw", "liquidate"]) {
      expect(seen[`${t} ok`] || 0, `${t} never succeeded`).to.be.gt(0);
      expect(seen[`${t} refused`] || 0, `${t} never refused`).to.be.gt(0);
    }
  });
});
