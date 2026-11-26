// Day 27 demo: a normal day, then admin key misuse and a split drain, watched by the monitor.
//   npm run demo
const { ethers } = require("hardhat");
const { ETH, deploy, makeMonitor, mine, later } = require("../lib/chain");

const DailyLimit = 0;
const line = (s = "") => console.log(s);

async function main() {
  const env = await deploy({ members: 10, each: 10, limit: 60 });
  const { vault, owner, users } = env;
  await vault.connect(users[0]).deposit({ value: ETH(20) });
  await later(86400);
  const m = makeMonitor(env);
  const settle = async () => { await mine(2); return m.poll(); };
  const show = (alerts) => {
    for (const a of alerts) line(`  [${a.severity.toUpperCase().padEnd(8)}] ${a.rule.padEnd(19)} ${a.message}${a.response ? `\n${" ".repeat(33)}→ ${a.response}` : ""}`);
    if (!alerts.length) line("  (no alerts)");
  };

  line("Day 27 — GuardedVault + monitor (10 members, 120 ETH, 60 ETH/day net limit, 2 confirmations)\n");

  line("1. A normal day: 6 deposits and 6 withdrawals spread over 12 hours");
  for (let i = 0; i < 6; i++) {
    await vault.connect(users[i]).deposit({ value: ETH(1) });
    await vault.connect(users[i + 1]).withdraw(ETH(2));
    await later(2 * 3600);
  }
  show(await settle());

  line("\n2. Admin key misuse: the stolen owner key queues a 10,000 ETH/day limit (lifting the breaker)");
  const q = await vault.connect(owner).queueDailyLimit(ETH(10000));
  const qBlock = (await q.wait()).blockNumber;
  show(await settle());
  line(`  on-chain: queued change ${(await vault.pending(DailyLimit)).eta === 0n ? "cancelled" : "STILL QUEUED"} (${(await ethers.provider.getBlockNumber()) - qBlock} blocks after it was queued)`);

  line("\n3. Unusual withdrawals: 9 addresses take 4 ETH each in a few minutes (each one looks small)");
  let last;
  for (const u of users.slice(1, 10)) last = (await (await vault.connect(u).withdraw(ETH(4))).wait()).blockNumber;
  const alerts = await settle();
  show(alerts);
  const blocked = await vault.connect(users[0]).withdraw(ETH(1)).then(() => "went through", (e) => `refused (${e.revert?.name || "reverted"})`);
  line(`  next withdrawal: ${blocked} · vault paused ${(await vault.queryFilter(vault.filters.Paused()))[0].blockNumber - last} blocks after the last drain tx`);

  line("\n4. The owner checks and unpauses; 2 hours later the whale takes 25 ETH at once");
  await vault.connect(owner).unpause();
  show(await settle());
  await later(2 * 3600);
  await vault.connect(users[0]).withdraw(ETH(25));
  show(await settle());

  line("\n5. A look-alike contract emits a fake 1,000 ETH Withdrawn event");
  const fake = await ethers.deployContract("FakeVault");
  await fake.fake(ETH(1000));
  show(await settle());

  const s = m.snapshot();
  const by = (sev) => s.alerts.filter((a) => a.severity === sev).length;
  line(`\nSummary: ${s.state.counts.deposits} deposits, ${s.state.counts.withdrawals} withdrawals, ${s.state.counts.admin} admin events → ${s.alerts.length} alerts (${by("critical")} critical, ${by("high")} high, ${by("medium")} medium, ${by("info")} info)`);
  const gas = async (p) => Number((await (await p).wait()).gasUsed);
  line(`Gas: deposit ${await gas(vault.connect(users[5]).deposit({ value: ETH(1) }))}, withdraw ${await gas(vault.connect(users[5]).withdraw(ETH(1)))}, pause ${await gas(vault.connect(env.guardian).pause())}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
