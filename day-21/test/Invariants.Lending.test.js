// Day 16 lending pool under attack: random deposits, redeems, collateral moves, borrows (fair
// and greedy), repays, price crashes and jumps, liquidations, donations and time jumps.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const fc = require("fast-check");
const { E, RUNS, STEPS, ok, token, fundAndApprove } = require("./helpers");

const START_PRICE = 10_00000000n; // 1 HIM = $10 (8 decimals, like Chainlink)

async function lendFixture() {
  const [deployer, ram, sita, hari, gita, liquidator] = await ethers.getSigners();
  const husd = await token("Himal USD", "HUSD", deployer.address);
  const him = await token("Himal Token", "HIM", deployer.address);
  const feed = await ethers.deployContract("HimalPriceFeed", [START_PRICE, deployer.address]);
  const lend = await ethers.deployContract("HimalLend", [
    await husd.getAddress(),
    await him.getAddress(),
    await feed.getAddress(),
    deployer.address,
  ]);
  const people = [ram, sita, hari, gita, liquidator];
  await fundAndApprove([husd, him], people, [await lend.getAddress()], E(10_000_000));
  await lend.connect(ram).deposit(E(500_000)); // the pool starts with cash to lend
  // Both borrowers start with 10,000 HIM ($100,000) as collateral and a $70,000 loan (limit $75,000),
  // so a price fall of about 12% makes them liquidatable.
  for (const b of [hari, gita]) {
    await lend.connect(b).depositCollateral(E(10_000));
    await lend.connect(b).borrow(E(70_000));
  }
  return { deployer, ram, sita, hari, gita, liquidator, husd, him, feed, lend };
}

const lender = fc.integer({ min: 0, max: 1 });
const borrower = fc.integer({ min: 0, max: 1 });
const pct = fc.integer({ min: 1, max: 100 });
const amount = fc.oneof(fc.bigInt({ min: 1n, max: 10_000n }), fc.bigInt({ min: E(1), max: E(200_000) }));
const action = fc.oneof(
  { weight: 2, arbitrary: fc.record({ t: fc.constant("deposit"), u: lender, a: amount }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("redeem"), u: lender, pct }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("collateral"), b: borrower, a: amount }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("uncollateral"), b: borrower, pct }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("borrow"), b: borrower, pct: fc.integer({ min: 50, max: 100 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("greedy"), b: borrower }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("repay"), b: borrower, pct }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("price"), pct: fc.integer({ min: 30, max: 160 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("price"), pct: fc.integer({ min: 60, max: 95 }) }) }, // a fall
  { weight: 3, arbitrary: fc.record({ t: fc.constant("liquidate"), b: borrower }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("donate"), a: amount }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("time"), s: fc.integer({ min: 1, max: 50 * 60 }) }) },
);

describe("Day 21 — invariants: Day 16 lending pool", function () {
  this.timeout(0);

  it(`${RUNS} random runs of up to ${STEPS} actions: backed, nobody borrows past the limit, lenders only lose to bad debt`, async function () {
    let stepsRun = 0;
    let greedyBlocked = 0;
    let liquidations = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(action, { minLength: 1, maxLength: STEPS, size: "max" }), async (actions) => {
        const f = await loadFixture(lendFixture);
        const { lend, husd, him, feed, deployer, liquidator } = f;
        const lenders = [f.ram, f.sita];
        const borrowers = [f.hari, f.gita];
        const everyone = [...lenders, ...borrowers, liquidator];
        const L = await lend.getAddress();
        const ONE_SHARE = 10n ** 24n; // shares carry 6 extra virtual decimals
        let price = START_PRICE;
        let sharePrice = await lend.previewRedeem(ONE_SHARE);
        let badDebt = 0n;

        for (const act of actions) {
          stepsRun++;
          const b = borrowers[act.b ?? 0];
          if (act.t === "deposit") {
            await ok(lend.connect(lenders[act.u]).deposit(act.a)); // dust that gives 0 shares is refused
          } else if (act.t === "redeem") {
            const s = ((await lend.sharesOf(lenders[act.u].address)) * BigInt(act.pct)) / 100n;
            if (s > 0n) await ok(lend.connect(lenders[act.u]).redeem(s)); // may lack cash while lent out
          } else if (act.t === "collateral") {
            expect(await ok(lend.connect(b).depositCollateral(act.a)), "adding collateral always works").to.equal(true);
          } else if (act.t === "uncollateral") {
            const c = ((await lend.collateralOf(b.address)) * BigInt(act.pct)) / 100n;
            if (c > 0n && (await ok(lend.connect(b).withdrawCollateral(c)))) {
              const debt = await lend.debtOf(b.address);
              // I4: you can never take collateral out and leave a debt above your limit.
              if (debt > 0n) expect(debt, "healthy after withdrawing collateral").to.be.lte(await lend.maxBorrow(b.address));
            }
          } else if (act.t === "borrow") {
            await lend.accrue();
            const max = await lend.maxBorrow(b.address);
            const debt = await lend.debtOf(b.address);
            const room = max > debt ? ((max - debt) * BigInt(act.pct)) / 100n : 0n;
            const cash = await lend.totalCash();
            const amt = room < cash ? room : cash;
            if (amt > 0n && (await ok(lend.connect(b).borrow(amt)))) {
              expect(await lend.debtOf(b.address), "healthy after borrowing").to.be.lte(await lend.maxBorrow(b.address));
            }
          } else if (act.t === "greedy") {
            // Borrow 1 wei more than the limit allows: must always fail.
            await lend.accrue();
            const max = await lend.maxBorrow(b.address);
            const debt = await lend.debtOf(b.address);
            if (max >= debt && (await lend.totalCash()) > max - debt) {
              expect(await ok(lend.connect(b).borrow(max - debt + 1n)), "borrowing past the limit").to.equal(false);
              greedyBlocked++;
            }
          } else if (act.t === "repay") {
            const amt = ((await lend.debtOf(b.address)) * BigInt(act.pct)) / 100n;
            if (amt > 0n) expect(await ok(lend.connect(b).repay(b.address, amt)), "repay works").to.equal(true);
          } else if (act.t === "price") {
            price = (price * BigInt(act.pct)) / 100n;
            if (price < 1000n) price = 1000n;
            await feed.connect(deployer).setPrice(price);
          } else if (act.t === "liquidate") {
            const debt = await lend.debtOf(b.address);
            if (await ok(lend.connect(liquidator).liquidate(b.address, debt > 0n ? debt : 1n))) liquidations++;
          } else if (act.t === "donate") {
            await husd.connect(deployer).transfer(L, act.a);
          } else if (act.t === "time") {
            await time.increase(act.s);
            await feed.connect(deployer).setPrice(price); // keep the price fresh (max age 1 hour)
          }

          // I1: the pool holds every HUSD its books say it has, and every HIM deposited as collateral.
          expect(await husd.balanceOf(L), `${act.t}: HUSD held >= totalCash`).to.be.gte(await lend.totalCash());
          let coll = 0n;
          let shares = 0n;
          let debtShares = 0n;
          for (const p of everyone) {
            coll += await lend.collateralOf(p.address);
            shares += await lend.sharesOf(p.address);
            debtShares += await lend.debtSharesOf(p.address);
          }
          expect(await him.balanceOf(L), `${act.t}: HIM held == collateral`).to.equal(coll);
          // I2: shares add up.
          expect(shares, `${act.t}: lender shares add up`).to.equal(await lend.totalShares());
          expect(debtShares, `${act.t}: debt shares add up`).to.equal(await lend.totalDebtShares());
          // I3: the reserves never claim more than the pool has.
          expect(await lend.reserves(), `${act.t}: reserves covered`).to.be.lte((await lend.totalCash()) + (await lend.totalDebt()));
          // I5: a lender's share never loses value, unless bad debt was written off openly.
          const sp = await lend.previewRedeem(ONE_SHARE);
          const bd = await lend.totalBadDebt();
          if (bd === badDebt) expect(sp, `${act.t}: share price never drops without bad debt`).to.be.gte(sharePrice);
          sharePrice = sp;
          badDebt = bd;
        }
      }),
      { numRuns: RUNS, seed: process.env.FUZZ_SEED ? Number(process.env.FUZZ_SEED) : undefined },
    );
    console.log(
      `      lending: ${stepsRun} random actions, ${greedyBlocked} greedy borrows blocked, ${liquidations} liquidations, 0 invariant breaks`,
    );
  });
});
