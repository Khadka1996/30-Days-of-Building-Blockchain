// Fuzz test with fast-check: random flash loans (good and bad borrowers, both tokens, any size)
// and random arbitrage runs of any size. After every action the invariants below must hold.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const fc = require("fast-check");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { E, fee, baseFixture, quoteRoundTrip, trade } = require("./helpers");

const RUNS = Number(process.env.FUZZ_RUNS || 40);

const action = fc.oneof(
  // mode: 0 repay, 1 keep, 2 wrong return, 3 approve less, 4 re-enter, 5 send back
  fc.record({ kind: fc.constant("loan"), mode: fc.nat(5), token: fc.nat(1), bps: fc.integer({ min: 0, max: 10_500 }) }),
  fc.record({ kind: fc.constant("arb"), amt: fc.integer({ min: 1, max: 600_000 }), extra: fc.integer({ min: -50, max: 50 }) })
);

async function fuzzFixture() {
  const f = await baseFixture();
  const borrower = await ethers.deployContract("TestBorrower", [f.L]);
  const B = await borrower.getAddress();
  await f.husd.transfer(B, E(100_000));
  await f.him.transfer(B, E(100_000));
  return { ...f, borrower, B };
}

describe("Fuzz: random flash loans and arbitrage never cost the lender a wei", function () {
  this.timeout(600_000);

  it(`${RUNS} random runs of up to 15 actions: the lender only ever gains its exact fee, the bot keeps nothing`, async function () {
    const f = await loadFixture(fuzzFixture);
    const tokens = [f.husd, f.him];
    const BOT = await f.bot.getAddress();

    await fc.assert(
      fc.asyncProperty(fc.array(action, { minLength: 1, maxLength: 15 }), async (actions) => {
        const snap = await ethers.provider.send("evm_snapshot", []);
        try {
          for (const a of actions) {
            const lenderBefore = await Promise.all(tokens.map((t) => t.balanceOf(f.L)));
            const feesBefore = await Promise.all(tokens.map((t) => f.lender.feesEarned(t)));
            let ok = false;
            let paid = [0n, 0n];

            if (a.kind === "loan") {
              const t = tokens[a.token];
              const T = await t.getAddress();
              const amount = (lenderBefore[a.token] * BigInt(a.bps)) / 10_000n;
              await f.borrower.setMode(a.mode);
              try {
                await f.borrower.borrow(T, amount);
                ok = true;
              } catch {}
              // Only a well-behaved borrower, asking for 1 wei … everything, may succeed.
              const shouldWork = a.mode === 0 && amount > 0n && amount <= lenderBefore[a.token];
              expect(ok, `loan mode ${a.mode} amount ${amount}`).to.equal(shouldWork);
              if (ok) paid[a.token] = fee(amount);
            } else {
              const amount = E(a.amt);
              const q = await quoteRoundTrip(f, amount);
              const minProfit = q.profit > 0n ? (q.profit * BigInt(100 + a.extra)) / 100n : 0n;
              const ownerBefore = await f.husd.balanceOf(f.manish.address);
              try {
                await f.bot.connect(f.manish).run(amount, await trade(f, minProfit));
                ok = true;
              } catch {}
              // It must work exactly when the quote is profitable enough, and pay exactly the quote.
              expect(ok, `arb ${a.amt} profit ${q.profit} min ${minProfit}`).to.equal(q.profit >= minProfit && q.profit >= 0n);
              if (ok) {
                expect((await f.husd.balanceOf(f.manish.address)) - ownerBefore).to.equal(q.profit);
                paid[0] = fee(amount);
              }
            }

            for (let i = 0; i < 2; i++) {
              // The lender's balance changes by exactly the fee (or not at all), never down.
              expect(await tokens[i].balanceOf(f.L)).to.equal(lenderBefore[i] + paid[i]);
              expect(await f.lender.feesEarned(tokens[i])).to.equal(feesBefore[i] + paid[i]);
              // The arbitrage bot never keeps tokens between transactions.
              expect(await tokens[i].balanceOf(BOT)).to.equal(0n);
            }
          }
        } finally {
          await ethers.provider.send("evm_revert", [snap]);
        }
      }),
      { numRuns: RUNS }
    );
  });
});
