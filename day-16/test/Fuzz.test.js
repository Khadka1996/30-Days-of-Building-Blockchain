const { expect } = require("chai");
const { ethers } = require("hardhat");
const fc = require("fast-check");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { E, P, DAY, baseFixture } = require("./helpers");

const RUNS = Number(process.env.FUZZ_RUNS || 40);
// Reverts we expect from random actions (borrowing too much, redeeming lent-out cash...). Anything
// else, above all a Solidity panic (overflow / underflow), fails the test.
const EXPECTED = ["Unhealthy", "InsufficientCash", "InsufficientCollateral", "NotLiquidatable", "ZeroAmount", "ERC20InsufficientBalance"];

const action = fc.record({
  kind: fc.constantFrom("deposit", "redeem", "collateral", "withdrawCollateral", "borrow", "repay", "liquidate", "wait", "price"),
  who: fc.nat(1),
  amount: fc.integer({ min: 1, max: 20_000 }),
  pct: fc.integer({ min: 1, max: 100 }),
  price: fc.integer({ min: 200, max: 2_000 }), // $2.00 to $20.00
  seconds: fc.integer({ min: 1, max: 60 * DAY }),
});

async function invariants(f, borrowers) {
  const { lend, husd, him, pool } = f;
  // 1. The books match the tokens really held.
  expect(await husd.balanceOf(pool)).to.equal(await lend.totalCash());
  let coll = 0n;
  let sumDebt = 0n;
  for (const b of borrowers) {
    coll += await lend.collateralOf(b.address);
    sumDebt += await lend.debtOf(b.address);
  }
  expect(await him.balanceOf(pool)).to.equal(coll);
  // 2. Total debt is the sum of every borrower's debt (each rounds up by at most 1 wei).
  const total = await lend.totalDebt();
  expect(sumDebt).to.be.gte(total);
  expect(sumDebt - total).to.be.lte(BigInt(borrowers.length));
  // 3. Reserves never exceed what the pool has or is owed (totalAssets would underflow).
  expect(await lend.reserves()).to.be.lte((await lend.totalCash()) + total);
  await lend.totalAssets();
}

describe("HimalLend — fuzz (fast-check)", function () {
  this.timeout(600_000);

  it(`${RUNS} random runs of up to 25 actions: books always match, no panic, and at the end everyone gets out`, async function () {
    await fc.assert(
      fc.asyncProperty(fc.array(action, { minLength: 1, maxLength: 25 }), async (actions) => {
        const f = await loadFixture(baseFixture);
        const { lend, husd, feed, ram, sita, hari, mina, gita, owner } = f;
        const lenders = [ram, sita];
        const borrowers = [hari, mina];
        await lend.connect(ram).deposit(E(5_000));
        let price = 10;

        for (const a of actions) {
          const l = lenders[a.who];
          const b = borrowers[a.who];
          let call;
          switch (a.kind) {
            case "deposit": call = () => lend.connect(l).deposit(E(a.amount)); break;
            case "redeem": call = async () => lend.connect(l).redeem(((await lend.sharesOf(l.address)) * BigInt(a.pct)) / 100n); break;
            case "collateral": call = () => lend.connect(b).depositCollateral(E(a.amount / 10)); break;
            case "withdrawCollateral": call = async () => lend.connect(b).withdrawCollateral(((await lend.collateralOf(b.address)) * BigInt(a.pct)) / 100n); break;
            case "borrow": call = () => lend.connect(b).borrow(E(a.amount / 2)); break;
            case "repay": call = () => lend.connect(b).repay(b.address, a.pct === 100 ? ethers.MaxUint256 : E(a.amount / 4)); break;
            case "liquidate": call = () => lend.connect(gita).liquidate(b.address, a.pct === 100 ? ethers.MaxUint256 : E(a.amount / 2)); break;
            case "wait": call = async () => { await time.increase(a.seconds); return feed.setPrice(P(price)); }; break;
            case "price": price = a.price / 100; call = () => feed.setPrice(P(price)); break;
          }
          try {
            await call();
            // 4. After a successful borrow or collateral withdrawal, the borrower is within 75% LTV.
            if (a.kind === "borrow" || a.kind === "withdrawCollateral") {
              expect(await lend.debtOf(b.address)).to.be.lte(await lend.maxBorrow(b.address));
            }
          } catch (e) {
            if (e.name === "AssertionError" || !EXPECTED.some((x) => e.message.includes(x))) throw e;
          }
          await invariants(f, borrowers);
        }

        // 5. End of the story: borrowers repay everything, then every lender can redeem every share.
        await time.increase(DAY);
        await feed.setPrice(P(price));
        for (const b of borrowers) {
          await husd.connect(owner).transfer(b.address, E(100_000));
          if ((await lend.debtSharesOf(b.address)) > 0n) await lend.connect(b).repay(b.address, ethers.MaxUint256);
          expect(await lend.debtOf(b.address)).to.equal(0n);
        }
        for (const l of lenders) {
          const s = await lend.sharesOf(l.address);
          if (s > 0n) await lend.connect(l).redeem(s);
        }
        await invariants(f, borrowers);
        // Only the reserves (plus a few wei of rounding) are left in the pool.
        const left = (await lend.totalCash()) - (await lend.reserves());
        expect(left).to.be.gte(0n);
        expect(left).to.be.lt(1000n);
      }),
      { numRuns: RUNS }
    );
  });
});
