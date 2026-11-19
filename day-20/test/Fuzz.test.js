// Fuzz test with fast-check: random sequences of deposits, withdrawals, redeems, invests,
// interest payments, harvests, losses, direct donations and time jumps by three users.
// After every action the vault's invariants must hold, and at the end everyone can leave.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const fc = require("fast-check");
const { E, baseFixture } = require("./helpers");

const RUNS = Number(process.env.FUZZ_RUNS || 40);
const ONE_SHARE = 10n ** 24n; // 1 hyHUSD (24 decimals)

const user = fc.integer({ min: 0, max: 2 });
const amount = fc.oneof(fc.bigInt({ min: 1n, max: 1000n }), fc.bigInt({ min: E(1), max: E(50_000) })); // dust or real
const action = fc.oneof(
  { weight: 3, arbitrary: fc.record({ t: fc.constant("deposit"), u: user, a: amount }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("redeem"), u: user, pct: fc.integer({ min: 1, max: 100 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("withdraw"), u: user, pct: fc.integer({ min: 1, max: 100 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("roundtrip"), u: user, a: amount }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("invest") }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("interest"), a: amount }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("harvest") }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("loss"), pct: fc.integer({ min: 1, max: 60 }) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("donate"), a: amount }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("time"), s: fc.integer({ min: 1, max: 8 * 3600 }) }) },
);

async function ok(p) {
  try {
    await (await p).wait();
    return true;
  } catch {
    return false;
  }
}

describe("Day 20 — fuzz: random actions keep the vault fair and solvent", function () {
  this.timeout(0);

  it(`${RUNS} random runs of up to 25 actions`, async function () {
    await fc.assert(
      fc.asyncProperty(fc.array(action, { minLength: 1, maxLength: 25 }), async (actions) => {
        const f = await loadFixture(baseFixture);
        const { vault, savings, husd, deployer, borrower, attacker } = f;
        const users = [f.ram, f.sita, f.hari];
        const V = await vault.getAddress();
        const S = await savings.getAddress();
        const trip = await ethers.deployContract("RoundTrip");
        let price = await vault.convertToAssets(ONE_SHARE);

        for (const act of actions) {
          let lossHappened = false;
          const u = users[act.u ?? 0];
          if (act.t === "deposit") {
            const expectShares = await vault.previewDeposit(act.a);
            const done = await ok(vault.connect(u).deposit(act.a, u.address));
            // The next block is 1 second later and the price can only rise (profit unlocking),
            // so a dust deposit may round to 0 shares and be refused; a real deposit never is.
            if (expectShares === 0n) expect(done, "a deposit that gives 0 shares is refused").to.equal(false);
            else if (!done) expect(act.a, "only dust deposits (<= 1,000 wei) may be refused").to.be.lte(1000n);
          } else if (act.t === "redeem") {
            const shares = ((await vault.balanceOf(u.address)) * BigInt(act.pct)) / 100n;
            const assets = await vault.previewRedeem(shares);
            const before = await husd.balanceOf(u.address);
            const done = await ok(vault.connect(u).redeem(shares, u.address, u.address));
            // A redeem worth >0 now is worth at least as much 1 second later.
            if (shares > 0n && assets > 0n) expect(done, "redeeming your own shares must succeed").to.equal(true);
            if (done) expect((await husd.balanceOf(u.address)) - before, "paid at least the quote").to.be.gte(assets);
          } else if (act.t === "withdraw") {
            const assets = ((await vault.maxWithdraw(u.address)) * BigInt(act.pct)) / 100n;
            const done = await ok(vault.connect(u).withdraw(assets, u.address, u.address));
            expect(done, "withdrawing up to maxWithdraw must succeed").to.equal(assets > 0n);
          } else if (act.t === "roundtrip") {
            // Deposit and redeem in ONE transaction: you must never get back more than you put in.
            const before = await husd.balanceOf(u.address);
            await husd.connect(u).approve(await trip.getAddress(), act.a);
            await ok(trip.connect(u).run(V, act.a));
            expect(await husd.balanceOf(u.address), "a same-block round trip never makes money").to.be.lte(before);
          } else if (act.t === "invest") {
            await ok(vault.invest());
          } else if (act.t === "interest") {
            await savings.connect(borrower).payInterest(act.a);
          } else if (act.t === "harvest") {
            await vault.harvest();
          } else if (act.t === "loss") {
            const held = await savings.totalAssets();
            const lost = (held * BigInt(act.pct)) / 100n;
            if (lost > 0n) {
              await savings.simulateLoss(lost, deployer.address);
              lossHappened = true;
            }
          } else if (act.t === "donate") {
            await husd.connect(attacker).transfer(V, act.a); // must be ignored
          } else if (act.t === "time") {
            await time.increase(act.s);
          }

          // ---- invariants after every action
          const total = await vault.totalAssets();
          const held = (await husd.balanceOf(V)) + (await husd.balanceOf(S));
          expect(total, "solvent: the vault never claims more HUSD than it holds").to.be.lte(held);
          expect(await vault.idle(), "cash counted <= cash held").to.be.lte(await husd.balanceOf(V));
          let shares = 0n;
          let owed = 0n;
          for (const p of users) {
            shares += await vault.balanceOf(p.address);
            owed += await vault.maxWithdraw(p.address);
          }
          expect(shares, "shares add up").to.equal(await vault.totalSupply());
          expect(owed, "everyone together can never take more than totalAssets").to.be.lte(total);
          const now = await vault.convertToAssets(ONE_SHARE);
          if (!lossHappened) expect(now, "without a loss the share price never falls").to.be.gte(price);
          price = now;
        }

        // ---- at the end, after all profit unlocks, everyone can leave
        await vault.harvest();
        await time.increase(31 * 86400);
        // (repeat: one exit can leave the others' dust shares worth 1 wei more)
        for (let pass = 0; pass < 3; pass++) {
          for (const p of users) {
            const s = await vault.balanceOf(p.address);
            if (s > 0n && (await vault.previewRedeem(s)) > 0n) await vault.connect(p).redeem(s, p.address, p.address);
          }
        }
        // Every share worth something was paid out; at most 1 wei of rounding dust is left per user.
        for (const p of users) expect(await vault.previewRedeem(await vault.balanceOf(p.address))).to.be.lte(1n);
      }),
      { numRuns: RUNS },
    );
  });
});
