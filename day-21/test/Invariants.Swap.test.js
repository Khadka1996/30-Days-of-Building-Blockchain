// Day 17 swap pool under attack: random adds, removes, fair swaps, greedy swaps (asking for
// 1 wei more than the formula allows), donations, sync and skim by three users.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const fc = require("fast-check");
const { E, RUNS, STEPS, ok, token, fundAndApprove } = require("./helpers");

async function swapFixture() {
  const [deployer, ram, sita, hari] = await ethers.getSigners();
  const him = await token("Himal Token", "HIM", deployer.address);
  const husd = await token("Himal USD", "HUSD", deployer.address);
  const pair = await ethers.deployContract("HimalPair", [await him.getAddress(), await husd.getAddress()]);
  await fundAndApprove([him, husd], [ram, sita, hari], [await pair.getAddress()], E(10_000_000));
  // Ram opens the pool at 1 HIM = 2 HUSD.
  await him.connect(ram).transfer(await pair.getAddress(), E(100_000));
  await husd.connect(ram).transfer(await pair.getAddress(), E(200_000));
  await pair.mint(ram.address);
  return { deployer, ram, sita, hari, him, husd, pair };
}

// The exact output the 0.3% fee formula allows (same maths as the Day 17 router).
const amountOut = (amountIn, rIn, rOut) => (amountIn * 997n * rOut) / (rIn * 1000n + amountIn * 997n);

const user = fc.integer({ min: 0, max: 2 });
const amount = fc.oneof(fc.bigInt({ min: 1n, max: 10_000n }), fc.bigInt({ min: E(1), max: E(500_000) }));
const action = fc.oneof(
  { weight: 2, arbitrary: fc.record({ t: fc.constant("add"), u: user, a: amount, skew: fc.integer({ min: 50, max: 150 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("remove"), u: user, pct: fc.integer({ min: 1, max: 100 }) }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant("swap"), u: user, a: amount, dir: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("greedy"), u: user, a: amount, dir: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("donate"), a: amount, dir: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("sync") }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("skim"), u: user }) },
);

describe("Day 21 — invariants: Day 17 swap pool", function () {
  this.timeout(0);

  it(`${RUNS} random runs of up to ${STEPS} actions: books match, LP value never drops, greedy swaps fail`, async function () {
    let stepsRun = 0;
    let greedyBlocked = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(action, { minLength: 1, maxLength: STEPS, size: "max" }), async (actions) => {
        const f = await loadFixture(swapFixture);
        const { pair, him, husd, deployer } = f;
        const users = [f.ram, f.sita, f.hari];
        const P = await pair.getAddress();
        const DEAD = await pair.DEAD();
        // Value of one LP share, scaled: √(r0 × r1) × 1e18 / supply. Fees make it grow; nothing may shrink it.
        const lpValue = async () => {
          const [r0, r1] = await pair.getReserves();
          const sqrt = (n) => {
            let x = n, y = (x + 1n) / 2n;
            while (y < x) [x, y] = [y, (y + n / y) / 2n];
            return x;
          };
          return (sqrt(r0 * r1) * 10n ** 18n) / (await pair.totalSupply());
        };
        let value = await lpValue();

        for (const act of actions) {
          stepsRun++;
          const u = users[act.u ?? 0];
          const [r0, r1] = await pair.getReserves();
          if (act.t === "add") {
            // Add at the pool price, or skewed up to ±50% (a bad ratio only hurts the adder).
            const a1 = (act.a * r1 * BigInt(act.skew)) / (r0 * 100n);
            if ((await him.balanceOf(u.address)) < act.a || (await husd.balanceOf(u.address)) < a1) continue;
            await him.connect(u).transfer(P, act.a);
            await husd.connect(u).transfer(P, a1);
            if (!(await ok(pair.connect(u).mint(u.address)))) await pair.skim(u.address); // dust: take it back
          } else if (act.t === "remove") {
            const lp = ((await pair.balanceOf(u.address)) * BigInt(act.pct)) / 100n;
            if (lp > 0n) {
              await pair.connect(u).transfer(P, lp);
              if (!(await ok(pair.connect(u).burn(u.address)))) {
                // Dust LP that would pay 0 of a token: it stays in the pool (a gift to the others).
              }
            }
          } else if (act.t === "swap" || act.t === "greedy") {
            // Tokens sent to the pool without a sync belong to whoever swaps or skims next (Uniswap V2
            // behaviour, QA.md F-08): the pool would count them as part of this swap's input. The
            // swapper takes them first with skim(), so the check below is about the swap alone.
            await pair.connect(u).skim(u.address);
            const [tin, rIn, rOut] = act.dir ? [him, r0, r1] : [husd, r1, r0];
            const out = amountOut(act.a, rIn, rOut);
            const ask = act.t === "greedy" ? out + 1n : out; // greedy: 1 wei more than allowed
            if ((await tin.balanceOf(u.address)) < act.a) continue; // this user ran out of tokens
            await tin.connect(u).transfer(P, act.a);
            const args = act.dir ? [0n, ask, u.address] : [ask, 0n, u.address];
            const done = ask > 0n && (await ok(pair.connect(u).swap(...args)));
            if (act.t === "greedy") {
              expect(done, "a swap asking 1 wei more than the formula must fail").to.equal(false);
              greedyBlocked++;
            } else if (out > 0n) {
              expect(done, "a fair swap always works").to.equal(true);
            }
            if (!done) await pair.connect(u).skim(u.address); // take the unused input back
          } else if (act.t === "donate") {
            await (act.dir ? him : husd).connect(deployer).transfer(P, act.a);
          } else if (act.t === "sync") {
            await pair.sync();
          } else if (act.t === "skim") {
            await pair.skim(u.address);
          }

          const [n0, n1] = await pair.getReserves();
          // I1: the pool never holds less than its books say.
          expect(await him.balanceOf(P), `${act.t}: HIM held >= reserve`).to.be.gte(n0);
          expect(await husd.balanceOf(P), `${act.t}: HUSD held >= reserve`).to.be.gte(n1);
          // I2: the 1,000 locked LP shares are still locked, so the pool can never be emptied.
          expect(await pair.balanceOf(DEAD)).to.equal(1000n);
          expect(n0 > 0n && n1 > 0n, `${act.t}: reserves never reach 0`).to.equal(true);
          // I3: no action makes an LP share worth less (fees and donations can only add).
          const v = await lpValue();
          expect(v, `${act.t}: LP share value never drops`).to.be.gte(value);
          value = v;
        }
      }),
      { numRuns: RUNS, seed: process.env.FUZZ_SEED ? Number(process.env.FUZZ_SEED) : undefined },
    );
    console.log(`      swap: ${stepsRun} random actions, ${greedyBlocked} greedy swaps blocked, 0 invariant breaks`);
  });
});
