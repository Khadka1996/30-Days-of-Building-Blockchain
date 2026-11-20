// Day 20 yield vault under attack: random deposits, redeems, one-block round trips, invests,
// interest payments, harvests, direct donations and time jumps by three users.
// (Day 20's own fuzz test also covers losses; here the focus is "nobody gets free money".)
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const fc = require("fast-check");
const { E, RUNS, STEPS, ok, token, fundAndApprove } = require("./helpers");

async function vaultFixture() {
  const [deployer, ram, sita, hari] = await ethers.getSigners();
  const husd = await token("Himal USD", "HUSD", deployer.address);
  const savings = await ethers.deployContract("HimalSavings", [await husd.getAddress()]);
  const vault = await ethers.deployContract("YieldVault", [await husd.getAddress(), await savings.getAddress(), 6 * 3600]);
  await savings.setVault(await vault.getAddress());
  await fundAndApprove([husd], [ram, sita, hari], [await vault.getAddress()], E(10_000_000));
  await husd.approve(await savings.getAddress(), ethers.MaxUint256);
  return { deployer, ram, sita, hari, husd, savings, vault };
}

const user = fc.integer({ min: 0, max: 2 });
const amount = fc.oneof(fc.bigInt({ min: 1n, max: 10_000n }), fc.bigInt({ min: E(1), max: E(500_000) }));
const action = fc.oneof(
  { weight: 3, arbitrary: fc.record({ t: fc.constant("deposit"), u: user, a: amount }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("redeem"), u: user, pct: fc.integer({ min: 1, max: 100 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("roundtrip"), u: user, a: amount }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("invest") }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("interest"), a: amount }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("harvest") }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("donate"), a: amount }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("time"), s: fc.integer({ min: 1, max: 8 * 3600 }) }) },
);

describe("Day 21 — invariants: Day 20 yield vault", function () {
  this.timeout(0);

  it(`${RUNS} random runs of up to ${STEPS} actions: backed, share price never drops, no free money`, async function () {
    let stepsRun = 0;
    let roundTrips = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(action, { minLength: 1, maxLength: STEPS, size: "max" }), async (actions) => {
        const f = await loadFixture(vaultFixture);
        const { vault, savings, husd, deployer } = f;
        const users = [f.ram, f.sita, f.hari];
        const V = await vault.getAddress();
        const ONE_SHARE = 10n ** 24n; // 6 virtual decimals on top of HUSD's 18
        let price = await vault.convertToAssets(ONE_SHARE);
        let putIn = 0n; // HUSD users deposited
        let takenOut = 0n; // HUSD users received
        let interest = 0n; // HUSD paid as interest or donated

        for (const act of actions) {
          stepsRun++;
          const u = users[act.u ?? 0];
          if (act.t === "deposit") {
            if (await ok(vault.connect(u).deposit(act.a, u.address))) putIn += act.a;
          } else if (act.t === "redeem") {
            const s = ((await vault.balanceOf(u.address)) * BigInt(act.pct)) / 100n;
            const h0 = await husd.balanceOf(u.address);
            if (s > 0n) await ok(vault.connect(u).redeem(s, u.address, u.address));
            takenOut += (await husd.balanceOf(u.address)) - h0;
          } else if (act.t === "roundtrip") {
            // Deposit, then redeem in the next block. Holding for that one block earns at most the
            // profit that unlocked during it (first version of this rule said "never any gain":
            // the fuzzer showed that was wrong, see QA.md F-07). Anything more would be theft.
            const h0 = await husd.balanceOf(u.address);
            const s0 = await vault.balanceOf(u.address);
            if (await ok(vault.connect(u).deposit(act.a, u.address))) {
              const lockedAtDeposit = await vault.lockedProfit();
              const got = (await vault.balanceOf(u.address)) - s0;
              await vault.connect(u).redeem(got, u.address, u.address);
              const unlocked = lockedAtDeposit - (await vault.lockedProfit());
              const back = (await husd.balanceOf(u.address)) - h0 + act.a;
              expect(back, "a 1-block round trip earns at most the profit unlocked in that block").to.be.lte(
                act.a + unlocked,
              );
              putIn += act.a;
              takenOut += back;
              roundTrips++;
            }
          } else if (act.t === "invest") {
            await ok(vault.invest());
          } else if (act.t === "interest") {
            await savings.connect(deployer).payInterest(act.a);
            interest += act.a;
          } else if (act.t === "harvest") {
            // New profit must NOT show up in the share price at once. In the 1 second of this block
            // the price may rise by at most the profit that was already locked (it keeps unlocking).
            const before = await vault.totalAssets();
            const lockedBefore = await vault.lockedProfit();
            await vault.harvest();
            expect((await vault.totalAssets()) - before, "harvest: no jump in value").to.be.lte(lockedBefore);
          } else if (act.t === "donate") {
            await husd.connect(deployer).transfer(V, act.a); // ignored by the vault's own books
            interest += act.a;
          } else if (act.t === "time") {
            await time.increase(act.s);
          }

          // I1: the vault never counts more HUSD than it and its strategy really hold.
          const total = await vault.totalAssets();
          expect(total, `${act.t}: backed`).to.be.lte((await husd.balanceOf(V)) + (await savings.totalAssets()));
          // I2: everyone's shares together are never worth more than the vault has.
          let owed = 0n;
          for (const p of users) owed += await vault.previewRedeem(await vault.balanceOf(p.address));
          expect(owed, `${act.t}: all shares covered`).to.be.lte(total);
          // I4: the vault's books never say the strategy holds more than it really does.
          expect(await vault.strategyAssets(), `${act.t}: strategy books <= real`).to.be.lte(await savings.totalAssets());
          expect(await vault.idle(), `${act.t}: cash books <= real`).to.be.lte(await husd.balanceOf(V));
          // I3: with no losses, the value of a share never goes down.
          const p = await vault.convertToAssets(ONE_SHARE);
          expect(p, `${act.t}: share price never drops`).to.be.gte(price);
          price = p;
        }

        // End: let profit unlock, everyone leaves. Users never get out more than they put in plus interest.
        await time.increase(7 * 3600);
        await vault.harvest();
        await time.increase(7 * 3600);
        for (const u of users) {
          const s = await vault.balanceOf(u.address);
          if (s === 0n) continue;
          const h0 = await husd.balanceOf(u.address);
          expect(await ok(vault.connect(u).redeem(s, u.address, u.address)), "everyone can leave").to.equal(true);
          takenOut += (await husd.balanceOf(u.address)) - h0;
        }
        expect(takenOut, "no free money").to.be.lte(putIn + interest);
      }),
      { numRuns: RUNS, seed: process.env.FUZZ_SEED ? Number(process.env.FUZZ_SEED) : undefined },
    );
    console.log(`      vault: ${stepsRun} random actions, ${roundTrips} one-block round trips, 0 invariant breaks`);
  });
});
