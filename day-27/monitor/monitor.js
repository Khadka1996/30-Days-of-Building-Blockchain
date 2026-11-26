// Day 27 — the monitor: reads the vault's events (viem), runs the alert rules, and
// responds to critical alerts with the guardian key (pause, or cancel a queued change).
//
//   poll():  head ─ confirmations → safe block
//            read logs [cursor+1 … safe] in chunks (only from the real vault address)
//            → decode → sort → rules → new alerts (deduplicated) → respond → save cursor
//
// It never reads unconfirmed blocks, never skips a block, and after a restart it
// continues from the saved cursor with the saved rule state, so no event is missed
// or counted twice.
const { decodeEventLog, isAddressEqual } = require("viem");
const { evaluate, initialState, KINDS } = require("./rules");
const { MemoryStore } = require("./store");

const MAX_ALERTS = 1000;

function createMonitor({
  client, // viem public client
  vault, // { address, abi, startBlock }
  config = {}, // rule settings, see rules.js DEFAULTS
  store = new MemoryStore(),
  confirmations = 2,
  chunk = 1000,
  guardian = null, // viem wallet client holding the guardian key (optional)
  autoPause = ["OUTFLOW_SPIKE", "UNKNOWN_ADMIN"],
  autoCancel = true, // cancel UNANNOUNCED_CHANGE while it is still queued
  responseMaxAgeSec = 3600, // never act on old history (e.g. when starting from block 0)
  log = () => {},
}) {
  let data = store.load();
  let seen = new Set((data?.alerts || []).map((a) => a.id));
  let lastError = null;
  let head = 0n;
  let headTime = 0;
  let running = null;

  async function init() {
    if (data) return;
    const at = { blockNumber: BigInt(vault.startBlock) };
    const read = (functionName, args = []) => client.readContract({ address: vault.address, abi: vault.abi, functionName, args, ...at });
    const [total, dailyLimit, owner, guardianAddr, paused] = await Promise.all([
      read("totalDeposits"), read("dailyLimit"), read("owner"), read("guardian"), read("paused"),
    ]);
    data = { cursor: BigInt(vault.startBlock) - 1n, state: initialState({ total, dailyLimit, owner, guardian: guardianAddr, paused }), alerts: [] };
    store.save(data);
  }

  async function getLogs(fromBlock, toBlock) {
    try {
      return await client.getLogs({ address: vault.address, fromBlock, toBlock });
    } catch (e) {
      if (toBlock <= fromBlock) throw e;
      // providers limit the block range: split the range in two and try again
      const mid = fromBlock + (toBlock - fromBlock) / 2n;
      return [...(await getLogs(fromBlock, mid)), ...(await getLogs(mid + 1n, toBlock))];
    }
  }

  function decode(l) {
    // Defence in depth: even if the RPC (or a bug) hands us other contracts' logs,
    // only the real vault's events count. A look-alike contract can emit anything.
    if (!isAddressEqual(l.address, vault.address)) return null;
    try {
      const { eventName, args } = decodeEventLog({ abi: vault.abi, data: l.data, topics: l.topics, strict: true });
      return { name: eventName, args, blockNumber: l.blockNumber, logIndex: Number(l.logIndex), txHash: l.transactionHash };
    } catch {
      return null; // not one of our events
    }
  }

  async function respond(alert, headTime) {
    const action = autoPause.includes(alert.rule) ? "pause" : alert.rule === "UNANNOUNCED_CHANGE" && autoCancel ? "cancel" : null;
    if (!guardian || !action) return; // most alerts are for humans only
    if (headTime - alert.time > responseMaxAgeSec) { alert.response = "not acted on: older than the response window"; return; }
    const write = async (functionName, args = []) => {
      const hash = await guardian.writeContract({ address: vault.address, abi: vault.abi, functionName, args, account: guardian.account, chain: guardian.chain });
      const r = await client.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error(`${functionName} reverted`);
      return hash;
    };
    try {
      if (action === "pause") {
        const paused = await client.readContract({ address: vault.address, abi: vault.abi, functionName: "paused" });
        if (paused) { alert.response = "vault already paused"; return; }
        alert.response = `guardian paused the vault (tx ${(await write("pause")).slice(0, 10)}…)`;
      } else {
        // Only cancel the exact change this alert is about, if it is still queued.
        const [value, eta] = await client.readContract({ address: vault.address, abi: vault.abi, functionName: "pending", args: [alert.kind] });
        if (Number(eta) !== alert.eta || value.toString() !== alert.value) { alert.response = "change no longer queued"; return; }
        alert.response = `guardian cancelled the ${KINDS[alert.kind]} change (tx ${(await write("cancel", [alert.kind])).slice(0, 10)}…)`;
      }
    } catch (e) {
      alert.response = `response failed: ${e.shortMessage || e.message}`;
    }
  }

  async function step() {
    await init();
    head = await client.getBlockNumber();
    const safe = head - BigInt(confirmations) + 1n; // a block with `confirmations` blocks on top (itself included)
    const fresh = [];
    if (safe <= data.cursor) return fresh;
    headTime = Number((await client.getBlock({ blockNumber: head })).timestamp);
    for (let from = data.cursor + 1n; from <= safe; from += BigInt(chunk)) {
      const to = from + BigInt(chunk) - 1n < safe ? from + BigInt(chunk) - 1n : safe;
      const events = (await getLogs(from, to)).map(decode).filter(Boolean)
        .sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
      const times = new Map();
      for (const ev of events) {
        if (!times.has(ev.blockNumber)) times.set(ev.blockNumber, (await client.getBlock({ blockNumber: ev.blockNumber })).timestamp);
        ev.timestamp = times.get(ev.blockNumber);
        for (const alert of evaluate(data.state, ev, config)) {
          if (seen.has(alert.id)) continue; // the same event never alerts twice
          seen.add(alert.id);
          await respond(alert, headTime);
          data.alerts.unshift(alert);
          fresh.push(alert);
          log(alert);
        }
      }
      data.alerts.length = Math.min(data.alerts.length, MAX_ALERTS);
      data.cursor = to;
      store.save(data); // progress is saved per chunk: a crash re-reads at most one chunk
    }
    return fresh;
  }

  /** Process every confirmed block not seen yet. Returns the new alerts. One poll at a time. */
  async function poll() {
    if (running) return running;
    running = step().then(
      (r) => { lastError = null; return r; },
      (e) => { lastError = e.details || e.shortMessage || e.message; throw e; },
    ).finally(() => { running = null; });
    return running;
  }

  function snapshot() {
    return { vault: vault.address, head: Number(head), headTime, cursor: data ? Number(data.cursor) : null, confirmations, lastError, state: data?.state, alerts: data?.alerts || [] };
  }

  return { poll, snapshot, get data() { return data; } };
}

module.exports = { createMonitor };
