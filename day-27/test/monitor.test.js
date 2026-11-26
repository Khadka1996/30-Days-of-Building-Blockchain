const { expect } = require("chai");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { ETH, deploy, makeMonitor, viemClient, mine, later, rules } = require("./helpers");
const { FileStore } = require("../monitor/store");

const DailyLimit = 0;
const settle = async (m) => { await mine(2); return m.poll(); }; // give the last tx 2 confirmations, then poll

describe("Day 27 — the monitor on a live chain (viem)", () => {
  let env, vault, owner, guardian, users, attacker;
  beforeEach(async () => {
    env = await deploy({ members: 10, each: 10, limit: 60 }); // 10 members × 10 ETH, 60 ETH/day limit
    ({ vault, owner, guardian, users } = env);
    await vault.connect(users[0]).deposit({ value: ETH(20) }); // one "whale" with 30 ETH: 120 ETH in the vault
    await later(86400); // deposits were "yesterday", so today's net limit is the plain 60 ETH
    attacker = env.signers[15];
  });

  it("normal activity raises no alerts", async () => {
    const m = makeMonitor(env);
    for (const [i, u] of users.slice(0, 4).entries()) {
      await vault.connect(u).deposit({ value: ETH(1) });
      await vault.connect(u).withdraw(ETH(2 + i));
      await later(2 * 3600); // spread over the day, like real use
    }
    expect(await settle(m)).to.deep.equal([]);
    const s = m.snapshot().state;
    expect([s.counts.deposits, s.counts.withdrawals, s.total]).to.deep.equal([15, 4, ETH(110)]);
  });

  it("flags one big withdrawal (≥ 20% of the vault)", async () => {
    const m = makeMonitor(env);
    await vault.connect(users[0]).withdraw(ETH(25));
    const alerts = await settle(m);
    expect(rules(alerts)).to.deep.equal(["LARGE_WITHDRAWAL"]);
    expect(alerts[0].severity).to.equal("high");
    expect(alerts[0].message).to.match(/withdrew 25 ETH, 20\.83% of the vault/);
  });

  it("F-4: one member taking their own money is 'high', not a reason to pause everyone", async () => {
    const m = makeMonitor(env);
    await vault.connect(users[0]).deposit({ value: ETH(20) });
    await vault.connect(users[0]).withdraw(ETH(45)); // the whale: 32% of the vault in one go
    const alerts = await settle(m);
    expect(alerts.map((a) => `${a.rule}/${a.severity}`)).to.deep.equal(["LARGE_WITHDRAWAL/high"]);
    expect(await vault.paused()).to.equal(false);
  });

  it("catches a drain split over many addresses, alerts ONCE, and the guardian pauses the vault", async () => {
    const m = makeMonitor(env);
    for (const u of users) await vault.connect(u).withdraw(ETH(4)); // 4 ETH each: far under the 'large' rule, 33% together
    const alerts = await settle(m);
    expect(rules(alerts).sort()).to.deep.equal(["OUTFLOW_SPIKE", "WITHDRAWAL_BURST"]);
    const spike = alerts.find((a) => a.rule === "OUTFLOW_SPIKE");
    expect(spike.severity).to.equal("critical");
    expect(spike.response).to.match(/guardian paused the vault/);
    expect(await vault.paused()).to.equal(true);
    await expect(vault.connect(users[0]).withdraw(ETH(1))).to.be.revertedWithCustomError(vault, "EnforcedPause");
    expect(rules(await settle(m))).to.deep.equal(["PAUSED"]); // the pause itself is reported too
  });

  it("F-2: a small spike can't be used to mute the alert for a much bigger drain (alert-only mode)", async () => {
    env = await deploy({ members: 10, each: 10, limit: 200 });
    ({ vault } = env);
    await vault.connect(env.users[0]).deposit({ value: ETH(20) }); // 120 ETH again
    const m = makeMonitor(env, { guardian: null });
    for (const u of env.users.slice(1, 10)) await vault.connect(u).withdraw(ETH(4)); // 36 ETH = 30%: first alert
    for (const u of env.users.slice(1, 10)) await vault.connect(u).withdraw(ETH(4)); // 72 ETH = 60%: must alert again
    const spikes = (await settle(m)).filter((a) => a.rule === "OUTFLOW_SPIKE");
    expect(spikes.map((a) => a.message.split(" (")[0])).to.deep.equal(["36 ETH", "72 ETH"]);
  });

  it("warns when today's outflow passes 80% of the on-chain daily limit", async () => {
    const m = makeMonitor(env, { config: { windowPct: 101, largePct: 101 } }); // isolate this rule
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    await time.increaseTo(Math.ceil(now / 86400) * 86400 + 60); // start of a fresh UTC day, like the contract
    for (const u of users.slice(0, 5)) { await vault.connect(u).withdraw(ETH(10)); await later(30 * 60); }
    const alerts = await settle(m);
    expect(rules(alerts)).to.deep.equal(["DAILY_LIMIT_NEAR"]);
    expect(alerts[0].message).to.match(/^50 ETH of the 60 ETH daily limit/);
  });

  it("admin key misuse: an unannounced change is flagged critical and cancelled before it can execute", async () => {
    const m = makeMonitor(env);
    await vault.connect(owner).queueDailyLimit(ETH(10000)); // stolen owner key: lift the breaker
    const [alert] = await settle(m);
    expect(alert.rule).to.equal("UNANNOUNCED_CHANGE");
    expect(alert.severity).to.equal("critical");
    expect(alert.response).to.match(/guardian cancelled the DailyLimit change/);
    expect((await vault.pending(DailyLimit)).eta).to.equal(0n);
    await later(86400);
    await expect(vault.execute(DailyLimit)).to.be.revertedWithCustomError(vault, "NothingQueued");
  });

  it("a change announced in advance is only info and is left alone", async () => {
    const m = makeMonitor(env, { config: { approvedChanges: [{ kind: "DailyLimit", value: ETH(80) }] } });
    await vault.queueDailyLimit(ETH(80));
    const alerts = await settle(m);
    expect(alerts.map((a) => [a.rule, a.severity])).to.deep.equal([["ADMIN_CHANGE", "info"]]);
    await later(86400);
    await vault.execute(DailyLimit);
    await settle(m);
    expect(m.snapshot().state.dailyLimit).to.equal(ETH(80)); // the rules follow the new limit
  });

  it("only cancels the exact change it alerted on, never a later planned one", async () => {
    const m = makeMonitor(env, { config: { approvedChanges: [{ kind: "DailyLimit", value: ETH(80) }] } });
    await vault.queueDailyLimit(ETH(10000)); // unannounced…
    await vault.cancel(DailyLimit); // …the owner notices the typo himself…
    await vault.queueDailyLimit(ETH(80)); // …and queues the planned change before the monitor runs
    const alerts = await settle(m);
    expect(alerts.find((a) => a.rule === "UNANNOUNCED_CHANGE").response).to.equal("change no longer queued");
    expect((await vault.pending(DailyLimit)).value).to.equal(ETH(80)); // the planned change survives
  });

  it("ownership to an unknown address is critical; when that address acts, the vault is paused", async () => {
    const m = makeMonitor(env);
    await vault.transferOwnership(attacker.address);
    await vault.connect(attacker).acceptOwnership();
    let alerts = await settle(m);
    expect(alerts.map((a) => `${a.rule}/${a.severity}`)).to.deep.equal(["OWNERSHIP/critical", "OWNERSHIP/critical"]);
    await vault.connect(attacker).queueGuardian(attacker.address);
    alerts = await settle(m);
    expect(rules(alerts)).to.deep.equal(["UNKNOWN_ADMIN", "UNANNOUNCED_CHANGE"]);
    expect(alerts[0].response).to.match(/paused/);
    expect(alerts[1].response).to.match(/cancelled the Guardian change/);
    expect(await vault.paused()).to.equal(true);
  });

  it("only reads blocks with 2 confirmations", async () => {
    const m = makeMonitor(env);
    await m.poll();
    await vault.connect(users[0]).withdraw(ETH(25)); // block N, now the head
    expect(await m.poll()).to.deep.equal([]); // 1 confirmation: not yet
    await mine(1);
    expect(rules(await m.poll())).to.deep.equal(["LARGE_WITHDRAWAL"]);
  });

  it("ignores look-alike events from other contracts, even if the RPC hands them over", async () => {
    const fake = await ethers.deployContract("FakeVault");
    const fakeAddr = (await fake.getAddress()).toLowerCase();
    // a lying RPC: drops our address filter, so the fake contract's logs come back too
    const client = viemClient({
      async after(method, params, result) {
        if (method !== "eth_getLogs") return result;
        const all = await require("hardhat").network.provider.request({ method, params: [{ ...params[0], address: undefined }] });
        return all;
      },
    });
    const m = makeMonitor(env, { client });
    await fake.fake(ETH(1000));
    const all = await settle(m);
    expect(all).to.deep.equal([]);
    expect(fakeAddr).to.not.equal(env.info.address.toLowerCase());
  });

  it("a restart continues from the saved cursor: nothing missed, nothing alerted twice", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "d27-")), "state.json");
    const m1 = makeMonitor(env, { store: new FileStore(file) });
    await vault.connect(users[0]).withdraw(ETH(25));
    expect(rules(await settle(m1))).to.deep.equal(["LARGE_WITHDRAWAL"]);
    for (const u of users.slice(1, 9)) await vault.connect(u).withdraw(ETH(3)); // starts before the "crash"…
    await mine(2);
    const m2 = makeMonitor(env, { store: new FileStore(file) }); // …and is finished by a new process
    for (const u of users.slice(1, 3)) await vault.connect(u).withdraw(ETH(1));
    const after = await settle(m2);
    expect(rules(after).sort()).to.deep.equal(["DAILY_LIMIT_NEAR", "OUTFLOW_SPIKE", "WITHDRAWAL_BURST"]);
    expect(m2.snapshot().alerts.filter((a) => a.rule === "LARGE_WITHDRAWAL")).to.have.length(1);
    expect(m2.snapshot().state.counts.withdrawals).to.equal(11);
  });

  it("splits block ranges when the RPC refuses big ones", async () => {
    const client = viemClient({
      async before(method, params) {
        if (method === "eth_getLogs" && BigInt(params[0].toBlock) - BigInt(params[0].fromBlock) > 3n) throw new Error("block range too large");
      },
    });
    const m = makeMonitor(env, { client });
    await vault.connect(users[0]).withdraw(ETH(25));
    expect(rules(await settle(m))).to.deep.equal(["LARGE_WITHDRAWAL"]);
    expect(m.snapshot().state.counts.deposits).to.equal(11);
  });

  it("an RPC outage is reported and the next poll recovers without losing events", async () => {
    let down = false;
    const m = makeMonitor(env, { client: viemClient({ async before() { if (down) throw new Error("connection refused"); } }) });
    await vault.connect(users[0]).withdraw(ETH(25));
    down = true;
    await mine(2);
    await m.poll().catch(() => {});
    expect(m.snapshot().lastError).to.match(/connection refused/);
    down = false;
    expect(rules(await m.poll())).to.deep.equal(["LARGE_WITHDRAWAL"]);
    expect(m.snapshot().lastError).to.equal(null);
  });

  it("does not act on old history when starting late (alerts only)", async () => {
    for (const u of users) await vault.connect(u).withdraw(ETH(4));
    await later(2 * 3600); // the monitor starts 2 hours after the spike
    const m = makeMonitor(env);
    const alerts = await settle(m);
    expect(alerts.find((a) => a.rule === "OUTFLOW_SPIKE").response).to.match(/not acted on/);
    expect(await vault.paused()).to.equal(false);
    expect(alerts.find((a) => a.rule === "WITHDRAWAL_BURST").response, "F-3: no note on alerts that never act").to.equal(undefined);
  });

  it("without a guardian key it only alerts", async () => {
    const m = makeMonitor(env, { guardian: null });
    for (const u of users) await vault.connect(u).withdraw(ETH(4));
    const alerts = await settle(m);
    expect(alerts.find((a) => a.rule === "OUTFLOW_SPIKE").response).to.equal(undefined);
    expect(await vault.paused()).to.equal(false);
  });
});
