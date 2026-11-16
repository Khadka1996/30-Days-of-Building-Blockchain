// Fuzz test with fast-check: random swaps (exact in / exact out, 1 or 2 hops) and random
// liquidity adds and removes by three people. After every action the invariants below must hold.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const fc = require("fast-check");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { E, MAX, soon, baseFixture } = require("./helpers");

const RUNS = Number(process.env.FUZZ_RUNS || 40);

const action = fc.oneof(
  fc.record({ kind: fc.constant("exactIn"), who: fc.nat(2), route: fc.nat(7), amt: fc.integer({ min: 1, max: 200_000 }) }),
  fc.record({ kind: fc.constant("exactOut"), who: fc.nat(2), route: fc.nat(7), amt: fc.integer({ min: 1, max: 5_000 }) }),
  fc.record({ kind: fc.constant("add"), who: fc.nat(2), pool: fc.nat(2), amt: fc.integer({ min: 1, max: 2_000 }) }),
  fc.record({ kind: fc.constant("remove"), who: fc.nat(2), pool: fc.nat(2), pct: fc.integer({ min: 1, max: 100 }) })
);

describe("Fuzz: random swaps and liquidity keep every pool honest", function () {
  this.timeout(600_000);

  it(`${RUNS} random runs of up to 20 actions: books match, k never falls on a swap, quotes are exact, router holds nothing`, async function () {
    const f = await loadFixture(baseFixture);
    const tokens = [f.him, f.husd, f.nprt];
    const { A } = f;
    const pools = [
      [A.him, A.husd],
      [A.husd, A.nprt],
      [A.him, A.nprt],
    ];
    const routes = [
      [A.him, A.husd], [A.husd, A.him], [A.husd, A.nprt], [A.nprt, A.husd],
      [A.him, A.nprt], [A.nprt, A.him], [A.him, A.husd, A.nprt], [A.nprt, A.husd, A.him],
    ];
    const pairs = await Promise.all(pools.map(([a, b]) => f.factory.getPair(a, b)));
    const pairC = await Promise.all(pairs.map((p) => ethers.getContractAt("HimalPair", p)));
    const users = [f.ram, f.sita, f.hari];
    for (const u of users) for (const p of pairC) await p.connect(u).approve(f.r, MAX);
    const totals = await Promise.all(tokens.map((t) => t.totalSupply()));

    const kOf = async (p) => {
      const [x, y] = await p.getReserves();
      return x * y;
    };

    async function checkInvariants() {
      for (const p of pairC) {
        const [r0, r1] = await p.getReserves();
        const t0 = await ethers.getContractAt("HimalToken", await p.token0());
        const t1 = await ethers.getContractAt("HimalToken", await p.token1());
        expect(await t0.balanceOf(await p.getAddress())).to.equal(r0, "pool balance == reserve0");
        expect(await t1.balanceOf(await p.getAddress())).to.equal(r1, "pool balance == reserve1");
        expect(r0 > 0n && r1 > 0n).to.equal(true, "a pool is never emptied (1,000 LP are locked)");
      }
      for (const t of tokens) expect(await t.balanceOf(f.r)).to.equal(0n, "router never holds tokens");
    }

    await fc.assert(
      fc.asyncProperty(fc.array(action, { minLength: 1, maxLength: 20 }), async (actions) => {
        const snap = await ethers.provider.send("evm_snapshot", []);
        try {
          for (const a of actions) {
            const u = users[a.who];
            const d = await soon();
            if (a.kind === "exactIn" || a.kind === "exactOut") {
              const path = routes[a.route];
              const hops = [];
              for (let i = 0; i < path.length - 1; i++) {
                const idx = pools.findIndex(([x, y]) => (x === path[i] && y === path[i + 1]) || (y === path[i] && x === path[i + 1]));
                hops.push({ p: pairC[idx], k: await kOf(pairC[idx]) });
              }
              const out = await ethers.getContractAt("HimalToken", path[path.length - 1]);
              const before = await out.balanceOf(u.address);
              let quoted;
              try {
                if (a.kind === "exactIn") {
                  quoted = (await f.router.getAmountsOut(E(a.amt), path)).at(-1);
                  await f.router.connect(u).swapExactTokensForTokens(E(a.amt), quoted, path, u.address, d);
                } else {
                  quoted = E(a.amt);
                  const need = (await f.router.getAmountsIn(quoted, path))[0];
                  await f.router.connect(u).swapTokensForExactTokens(quoted, need, path, u.address, d);
                }
              } catch (e) {
                // Only honest refusals are allowed: "the pool is too small" or "you cannot afford it"
                // (a big exact-out buy from a thin pool can cost more than the trader holds).
                // Never a panic, a k failure or a slippage failure.
                expect(e.message).to.match(/InsufficientLiquidity\b|InsufficientAmount|ERC20InsufficientBalance/);
                continue;
              }
              expect((await out.balanceOf(u.address)) - before).to.equal(quoted, "received exactly the quote");
              for (const h of hops) expect(await kOf(h.p)).to.be.greaterThanOrEqual(h.k, "k never falls on a swap");
            } else if (a.kind === "add") {
              const [x, y] = pools[a.pool];
              await f.router.connect(u).addLiquidity(x, y, E(a.amt), E(a.amt * 1_000), 0, 0, u.address, d);
            } else {
              const [x, y] = pools[a.pool];
              const lp = await pairC[a.pool].balanceOf(u.address);
              const amount = (lp * BigInt(a.pct)) / 100n;
              if (amount > 0n) await f.router.connect(u).removeLiquidity(x, y, amount, 0, 0, u.address, d);
            }
            await checkInvariants();
          }
          // At the end everyone takes out all their liquidity: nobody's money is stuck.
          for (const u of users) {
            for (let i = 0; i < 3; i++) {
              const lp = await pairC[i].balanceOf(u.address);
              if (lp > 0n) await f.router.connect(u).removeLiquidity(...pools[i], lp, 1, 1, u.address, await soon());
            }
          }
          await checkInvariants();
          // No token was created or destroyed anywhere.
          for (let i = 0; i < 3; i++) expect(await tokens[i].totalSupply()).to.equal(totals[i]);
        } finally {
          await ethers.provider.send("evm_revert", [snap]);
        }
      }),
      { numRuns: RUNS }
    );
  });
});
