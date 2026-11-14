const { expect } = require("chai");
const fc = require("fast-check");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { E, DAY, baseFixture, Model } = require("./helpers");

// Random sequences of stake / withdraw / claim / add-rewards / wait by 3 stakers.
// After every step the contract must match an exact JavaScript model, and the pool
// must always hold enough HRW to pay everything it owes (solvency invariant).
const op = fc.oneof(
  fc.record({ kind: fc.constant("stake"), who: fc.nat(2), amt: fc.bigInt(1n, E(3_000)) }),
  fc.record({ kind: fc.constant("withdraw"), who: fc.nat(2), pct: fc.integer({ min: 1, max: 100 }) }),
  fc.record({ kind: fc.constant("claim"), who: fc.nat(2) }),
  fc.record({ kind: fc.constant("notify"), reward: fc.bigInt(1n, E(50_000)), days: fc.integer({ min: 1, max: 30 }) }),
  fc.record({ kind: fc.constant("wait"), secs: fc.integer({ min: 1, max: 5 * DAY }) })
);

describe("Fuzz: HimalStaking matches the model and stays solvent", function () {
  this.timeout(300_000);

  it("40 random runs of up to 18 actions each", async function () {
    let runs = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 4, maxLength: 18 }), async (ops) => {
        const { staking, hrw, ram, sita, attacker, pool } = await loadFixture(baseFixture);
        const users = [ram, sita, attacker];
        const m = new Model();
        let funded = 0n, claimed = 0n;
        let now = BigInt(await time.latest());

        for (const o of ops) {
          now += 1n + BigInt(o.kind === "wait" ? o.secs : 0);
          if (o.kind === "wait") { await time.setNextBlockTimestamp(now); await ethers.provider.send("evm_mine", []); continue; }
          await time.setNextBlockTimestamp(now);
          if (o.kind === "stake") {
            // Never stake more than the wallet holds (each starts with 10,000 HIM).
            const wallet = E(10_000) - (m.bal[o.who] || 0n);
            const amt = o.amt < wallet ? o.amt : wallet;
            if (amt === 0n) { await ethers.provider.send("evm_mine", []); continue; }
            await staking.connect(users[o.who]).stake(amt);
            m.stake(o.who, amt, now);
          } else if (o.kind === "withdraw") {
            const bal = m.bal[o.who] || 0n;
            const amt = (bal * BigInt(o.pct)) / 100n;
            if (amt === 0n) { await ethers.provider.send("evm_mine", []); continue; }
            await staking.connect(users[o.who]).withdraw(amt);
            m.withdraw(o.who, amt, now);
          } else if (o.kind === "claim") {
            const before = await hrw.balanceOf(users[o.who].address);
            await staking.connect(users[o.who]).getReward();
            const got = (await hrw.balanceOf(users[o.who].address)) - before;
            expect(got).to.equal(m.claim(o.who, now));
            claimed += got;
          } else {
            await staking.notifyRewardAmount(o.reward, o.days * DAY);
            m.notify(o.reward, BigInt(o.days * DAY), now);
            funded += o.reward;
          }

          // Exact match with the model.
          expect(await staking.totalStaked()).to.equal(m.total);
          expect(await staking.rewardPerTokenStored()).to.equal(m.rpt);
          let owed = 0n;
          for (let i = 0; i < 3; i++) {
            const e = await staking.earned(users[i].address);
            expect(e).to.equal(m.earned(i, now));
            owed += e;
          }
          // Solvency: what is owed never exceeds what the pool holds.
          expect(await hrw.balanceOf(pool)).to.be.gte(owed);
          expect(claimed + owed).to.be.lte(funded);
        }
        runs++;
      }),
      { numRuns: Number(process.env.FUZZ_RUNS || 40) }
    );
    expect(runs).to.equal(Number(process.env.FUZZ_RUNS || 40));
  });

  it("30 random two-staker weeks: nothing is lost except a few wei of rounding", async function () {
    await fc.assert(
      fc.asyncProperty(
        fc.bigInt(1n, E(5_000)), fc.bigInt(1n, E(5_000)), fc.bigInt(10n ** 6n, E(100_000)), fc.integer({ min: 0, max: 7 * DAY - 2 }),
        async (a, b, reward, joinAfter) => {
          const { staking, ram, sita } = await loadFixture(baseFixture);
          await staking.connect(ram).stake(a);
          const t0 = (await time.latest()) + 1;
          await time.setNextBlockTimestamp(t0);
          await staking.notifyRewardAmount(reward, 7 * DAY);
          await time.setNextBlockTimestamp(t0 + 1 + joinAfter);
          await staking.connect(sita).stake(b);
          await time.increaseTo(t0 + 7 * DAY + 10);
          const total = (await staking.earned(ram.address)) + (await staking.earned(sita.address));
          expect(total).to.be.lte(reward);
          expect(reward - total).to.be.lte(5n); // at most 5 wei of rounding dust
        }
      ),
      { numRuns: Number(process.env.FUZZ_RUNS || 30) }
    );
  });
});
