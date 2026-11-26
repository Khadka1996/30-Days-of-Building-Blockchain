// Day 27 — the live dashboard: a local chain with normal traffic, the monitor (polling twice
// a second, 2 confirmations, guardian key) and the page at http://127.0.0.1:4027.
// After ~20 s a stolen owner key queues a huge limit; after ~35 s a split drain starts.
//   npm run app        (Ctrl+C to stop)
const { ETH, deploy, makeMonitor, mine, later } = require("../lib/chain");
const { createDashboard } = require("../monitor/server");

async function main() {
  const env = await deploy({ members: 10, each: 10, limit: 60 });
  const { vault, owner, users } = env;
  await vault.connect(users[0]).deposit({ value: ETH(20) });
  await later(86400);
  const monitor = makeMonitor(env, { log: (a) => console.log(`[${a.severity}] ${a.rule}: ${a.message}${a.response ? ` → ${a.response}` : ""}`) });
  const dash = await createDashboard({ monitor, port: Number(process.env.PORT || 4027) });
  console.log(`Dashboard: ${dash.url}  (vault ${env.info.address})`);

  // one job at a time: blocks, traffic and polls never race
  let queue = Promise.resolve();
  const serial = (fn) => (queue = queue.then(fn).catch((e) => console.error(e.shortMessage || e.message)));
  const started = Date.now();
  let tick = 0, drained = 0;

  setInterval(() => serial(() => mine(1)), 1000); // a block every second, like a fast L2
  setInterval(() => serial(() => monitor.poll()), 500);
  setInterval(() => serial(async () => {
    tick++;
    const u = users[tick % users.length];
    const secs = (Date.now() - started) / 1000;
    if (secs > 20 && !main.misused) {
      main.misused = true;
      console.log("» attack 1: the stolen owner key queues a 10,000 ETH/day limit");
      return vault.connect(owner).queueDailyLimit(ETH(10000));
    }
    if (secs > 35 && drained < 9 && !(await vault.paused())) {
      drained++;
      if (drained === 1) console.log("» attack 2: 9 addresses withdraw 4 ETH each");
      return vault.connect(users[drained]).withdraw(ETH(4));
    }
    // normal traffic: small deposits and withdrawals (none while the vault is paused)
    if (await vault.paused()) return;
    if (tick % 2) return vault.connect(u).deposit({ value: ETH(0.5) });
    return vault.connect(u).withdraw(ETH(0.3));
  }), 2000);
}

main().catch((e) => { console.error(e); process.exit(1); });
