const { expect } = require("chai");
const fc = require("fast-check");
const { ethers } = require("hardhat");
const { evaluate, initialState, DEFAULTS } = require("../monitor/rules");
const { MemoryStore } = require("../monitor/store");
const { ETH, deploy, makeMonitor, mine, later } = require("./helpers");

describe("Day 27 — fuzzing", () => {
  it("rules: however a drain is split (sizes, timing, addresses), the outflow alert never misses, never spams, never cries wolf", () => {
    let runs = 0, spikes = 0, mustFire = 0;
    fc.assert(fc.property(
      fc.array(fc.record({ amount: fc.integer({ min: 1, max: 12 }), dt: fc.integer({ min: 0, max: 1800 }), user: fc.integer({ min: 0, max: 9 }) }), { minLength: 1, maxLength: 40 }),
      (steps) => {
        runs++;
        const cfg = DEFAULTS;
        const state = initialState({ total: ETH(100), dailyLimit: ETH(10000) });
        let t = 1_700_000_000, total = ETH(100);
        const hist = []; // reference: every withdrawal so far, checked by brute force
        const fired = [];
        steps.forEach((s, i) => {
          t += s.dt;
          const amount = ETH(s.amount);
          if (amount > total) return;
          total -= amount;
          hist.push({ t, amount });
          const alerts = evaluate(state, { name: "Withdrawn", args: { user: ethers.getAddress(`0x${(s.user + 1).toString(16).padStart(40, "0")}`), amount, totalAfter: total }, blockNumber: BigInt(i + 1), logIndex: 0, txHash: `0x${i}`, timestamp: BigInt(t) }, cfg);
          const win = hist.filter((h) => h.t > t - cfg.windowSec);
          const inWin = win.reduce((x, h) => x + h.amount, 0n);
          const cond = win.length >= 2 && inWin >= cfg.windowMinWei && inWin * 100n >= BigInt(cfg.windowPct) * (total + inWin);
          const spike = alerts.some((a) => a.rule === "OUTFLOW_SPIKE");
          if (spike) { expect(cond, "no false alarm").to.equal(true); fired.push({ t, out: inWin }); spikes++; }
          if (cond) {
            mustFire++;
            // no miss: a spike fired now, or one fired within the last window (one alert per episode)
            expect(spike || fired.some((f) => f.t > t - cfg.windowSec), "missed a drain").to.equal(true);
          }
        });
        // no spam: a repeat within the window only when the outflow at least doubled (F-2)
        for (let i = 1; i < fired.length; i++) {
          if (fired[i].t - fired[i - 1].t < cfg.windowSec) expect(fired[i].out >= fired[i - 1].out * 2n, "spam").to.equal(true);
        }
      },
    ), { numRuns: 400, seed: 27 });
    console.log(`      fuzz: ${runs} random withdrawal sequences, ${mustFire} drain moments, ${spikes} alerts, 0 missed, 0 false`);
  });

  it("live chain: a monitor that crashes and restarts at random gives exactly the same alerts as one that never stops", async function () {
    this.timeout(300000);
    let runs = 0, crashes = 0, total = 0;
    await fc.assert(fc.asyncProperty(
      fc.array(fc.oneof(
        fc.record({ op: fc.constant("withdraw"), user: fc.nat(9), amount: fc.integer({ min: 1, max: 9 }) }),
        fc.record({ op: fc.constant("deposit"), user: fc.nat(9), amount: fc.integer({ min: 1, max: 5 }) }),
        fc.record({ op: fc.constant("wait"), sec: fc.integer({ min: 60, max: 2400 }) }),
        fc.record({ op: fc.constant("crash") }),
      ), { minLength: 10, maxLength: 30 }),
      async (ops) => {
        runs++;
        const env = await deploy({ members: 10, each: 10, limit: 60 });
        const config = { windowPct: 15, burstCount: 4, largePct: 8 }; // tighter rules: more alerts to compare
        const steady = makeMonitor(env, { guardian: null, config });
        const store = new MemoryStore();
        let flaky = makeMonitor(env, { guardian: null, store, config });
        for (const [i, o] of ops.entries()) {
          if (o.op === "withdraw") await env.vault.connect(env.users[o.user]).withdraw(ETH(o.amount)).catch(() => {});
          else if (o.op === "deposit") await env.vault.connect(env.users[o.user]).deposit({ value: ETH(o.amount) });
          else if (o.op === "wait") await later(o.sec);
          else { await flaky.poll(); flaky = makeMonitor(env, { guardian: null, store, config }); crashes++; } // poll, then lose the process
          if (i % 3 === 2) await steady.poll(); // the steady one polls on its own rhythm
        }
        await mine(2);
        await steady.poll();
        await flaky.poll();
        const ids = (m) => m.snapshot().alerts.map((a) => a.id).sort();
        expect(ids(flaky)).to.deep.equal(ids(steady));
        expect(new Set(ids(flaky)).size).to.equal(ids(flaky).length);
        expect(flaky.snapshot().state.total).to.equal(await env.vault.totalDeposits());
        total += ids(flaky).length;
      },
    ), { numRuns: 25, seed: 27 });
    console.log(`      fuzz: ${runs} random live runs, ${crashes} crashes, ${total} alerts — identical to a monitor that never stopped`);
  });
});
