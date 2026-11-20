// Day 15 staking under attack: random stakes, withdrawals, claims, reward top-ups, direct
// donations and time jumps by four users. The SAME actions go to two contracts in the SAME block:
//   - the original Day 15 HimalStaking, and
//   - HimalStakingV1 behind a UUPS proxy, which may be upgraded to V2 in the middle of a run.
// After every step both must hold the invariants below AND agree on every number
// (differential fuzzing: the proxy must behave exactly like the original, before and after the upgrade).
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const fc = require("fast-check");
const { E, RUNS, STEPS, stakingFixture } = require("./helpers");

const user = fc.integer({ min: 0, max: 3 });
const amount = fc.oneof(fc.bigInt({ min: 1n, max: 10_000n }), fc.bigInt({ min: E(1), max: E(100_000) }));
const action = fc.oneof(
  { weight: 4, arbitrary: fc.record({ t: fc.constant("stake"), u: user, a: amount }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("withdraw"), u: user, pct: fc.integer({ min: 1, max: 100 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("claim"), u: user }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("notify"), a: amount, d: fc.integer({ min: 1, max: 30 }) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("donate"), a: amount }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("upgrade") }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("time"), s: fc.integer({ min: 1, max: 3 * 24 * 3600 }) }) },
);

const GAS = { gasLimit: 1_000_000 };

/** Send one transaction to each contract and mine them in ONE block, so both see the same time. */
async function sameBlock(sendFns) {
  await network.provider.send("evm_setAutomine", [false]);
  const sent = [];
  try {
    for (const send of sendFns) sent.push(await send());
  } finally {
    await network.provider.send("evm_mine");
    await network.provider.send("evm_setAutomine", [true]);
  }
  const results = [];
  for (const tx of sent) {
    try {
      await tx.wait();
      results.push(true);
    } catch {
      results.push(false);
    }
  }
  return results;
}

describe("Day 21 — invariants: Day 15 staking and its UUPS proxy, side by side", function () {
  this.timeout(0);

  it(`${RUNS} random runs of up to ${STEPS} actions: solvent, fair, and identical across the upgrade`, async function () {
    let stepsRun = 0;
    let upgradesRun = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(action, { minLength: 1, maxLength: STEPS, size: "max" }), async (actions) => {
        const f = await loadFixture(stakingFixture);
        const { him, hrw, owner, guardian } = f;
        const users = [f.ram, f.sita, f.hari, f.attacker];
        let proxy = f.proxy;
        const both = () => [f.plain, proxy];
        const model = users.map(() => 0n); // HIM each user should have staked
        let funded = 0n; // HRW put in by the owner
        let upgraded = false;
        const paid = [0n, 0n]; // HRW each contract has paid out

        const check = async (label) => {
          const [a, b] = both();
          for (const c of [a, b]) {
            const C = await c.getAddress();
            const total = await c.totalStaked();
            // I1: the staked total is exactly what users put in, and the contract holds at least that.
            expect(total, `${label}: totalStaked`).to.equal(model.reduce((x, y) => x + y, 0n));
            expect(await him.balanceOf(C), `${label}: HIM held >= staked`).to.be.gte(total);
            let promised = 0n;
            for (let i = 0; i < users.length; i++) {
              // I2: every balance matches the model.
              expect(await c.balanceOf(users[i].address), `${label}: balance ${i}`).to.equal(model[i]);
              promised += await c.earned(users[i].address);
            }
            // I3: the contract never promises more HRW than it holds.
            expect(promised, `${label}: rewards promised <= HRW held`).to.be.lte(await hrw.balanceOf(C));
          }
          // I4: differential: the proxy and the original agree on every number.
          expect(await b.rewardPerToken(), `${label}: rewardPerToken equal`).to.equal(await a.rewardPerToken());
          for (const u of users) expect(await b.earned(u.address), `${label}: earned equal`).to.equal(await a.earned(u.address));
        };

        for (const act of actions) {
          stepsRun++;
          const i = act.u ?? 0;
          const u = users[i];
          if (act.t === "stake") {
            const res = await sameBlock(both().map((c) => () => c.connect(u).stake(act.a, GAS)));
            expect(res[0], "stake succeeds on both or neither").to.equal(res[1]);
            expect(res[0], "a stake by a funded user never fails").to.equal(true);
            model[i] += act.a;
          } else if (act.t === "withdraw") {
            const amt = (model[i] * BigInt(act.pct)) / 100n;
            const res = await sameBlock(both().map((c) => () => c.connect(u).withdraw(amt, GAS)));
            expect(res[0]).to.equal(res[1]);
            // Withdrawing what you staked must ALWAYS work (no lock, no pause on withdrawals).
            expect(res[0], "withdraw of own stake").to.equal(amt > 0n);
            if (res[0]) model[i] -= amt;
          } else if (act.t === "claim") {
            const held = await Promise.all(both().map(async (c) => hrw.balanceOf(await c.getAddress())));
            const res = await sameBlock(both().map((c) => () => c.connect(u).getReward(GAS)));
            expect(res, "claiming never fails").to.deep.equal([true, true]);
            for (const [k, c] of both().entries()) paid[k] += held[k] - (await hrw.balanceOf(await c.getAddress()));
          } else if (act.t === "notify") {
            const res = await sameBlock(
              both().map((c) => () => c.connect(owner).notifyRewardAmount(act.a, act.d * 24 * 3600, GAS)),
            );
            expect(res[0]).to.equal(res[1]);
            if (res[0]) funded += act.a;
          } else if (act.t === "donate") {
            await sameBlock(both().map((c) => async () => him.transfer(await c.getAddress(), act.a, GAS)));
          } else if (act.t === "upgrade" && !upgraded) {
            // Upgrade the proxy to V2 in the middle of the run (only the proxy; the original stays).
            const v2Impl = await ethers.deployContract("HimalStakingV2");
            const data = v2Impl.interface.encodeFunctionData("initializeV2", [guardian.address]);
            await proxy.connect(owner).upgradeToAndCall(await v2Impl.getAddress(), data);
            proxy = await ethers.getContractAt("HimalStakingV2", await proxy.getAddress());
            expect(await proxy.version()).to.equal("2.0.0");
            upgraded = true;
            upgradesRun++;
          } else if (act.t === "time") {
            await time.increase(act.s);
          }
          await check(act.t);
        }

        // End of run: let rewards finish, then everyone leaves. Everyone gets every HIM back,
        // both contracts pay exactly the same HRW, and never more than was funded.
        await time.increase(31 * 24 * 3600);
        for (let i = 0; i < users.length; i++) {
          const u = users[i];
          for (const [k, c] of both().entries()) {
            const h0 = await him.balanceOf(u.address);
            const r0 = await hrw.balanceOf(u.address);
            if (model[i] > 0n) await c.connect(u).withdraw(model[i]);
            await c.connect(u).getReward();
            expect((await him.balanceOf(u.address)) - h0, "every staked HIM comes back").to.equal(model[i]);
            paid[k] += (await hrw.balanceOf(u.address)) - r0;
          }
        }
        expect(paid[1], "proxy paid the same HRW as the original").to.equal(paid[0]);
        expect(paid[0], "never more HRW than funded").to.be.lte(funded);
        for (const c of both()) {
          // Conservation: whatever was funded and not paid is still in the contract.
          expect(await hrw.balanceOf(await c.getAddress())).to.equal(funded - paid[0]);
        }
      }),
      { numRuns: RUNS, seed: process.env.FUZZ_SEED ? Number(process.env.FUZZ_SEED) : undefined },
    );
    console.log(`      staking: ${stepsRun} random actions, ${upgradesRun} upgrades mid-run, 0 invariant breaks`);
  });
});
