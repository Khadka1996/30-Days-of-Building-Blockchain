// Day 27 — alert rules. Pure functions: (state, event, config) → alerts.
// No network, no clock: the time of an event is its block timestamp, so the same
// events always give the same alerts (easy to test, safe to replay after a restart).
const { formatEther, getAddress } = require("viem");

const KINDS = ["DailyLimit", "Guardian"];
const SEVERITY = { info: 0, medium: 1, high: 2, critical: 3 };

const DEFAULTS = {
  knownAdmins: [], // owner + guardian addresses we expect to see doing admin things
  approvedOwners: [], // planned ownership transfers (announced in advance)
  approvedChanges: [], // planned timelocked changes: { kind: "DailyLimit" | "Guardian", value }
  largePct: 20, // one withdrawal ≥ 20% of the vault…
  largeMinWei: 10n ** 18n, // …and at least 1 ETH
  windowSec: 3600, // rolling window for the outflow rule
  windowPct: 30, // ≥ 30% of the vault leaving within the window…
  windowMinWei: 10n ** 18n, // …and at least 1 ETH
  burstCount: 8, // ≥ 8 withdrawals…
  burstSec: 600, // …within 10 minutes
  limitNearPct: 80, // today's outflow crossed 80% of the on-chain daily limit
};

function initialState({ total = 0n, dailyLimit = 0n, owner, guardian, paused = false } = {}) {
  return {
    total, dailyLimit, paused,
    owner: owner ? getAddress(owner) : null,
    guardian: guardian ? getAddress(guardian) : null,
    pending: {}, // kind → { value, eta }
    window: [], // recent withdrawals { t, amount }
    day: -1, inToday: 0n, outToday: 0n, // mirrors the contract's net daily limit
    spikeOut: 0n, // outflow at the last OUTFLOW_SPIKE alert (to escalate, F-2)
    mutedUntil: {}, // rule → timestamp: one alert per episode, not one per event
    counts: { deposits: 0, withdrawals: 0, admin: 0 },
  };
}

const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const inList = (list, a) => list.some((x) => same(x, a));
const eth = (wei) => `${Number(formatEther(wei)).toLocaleString("en-US", { maximumFractionDigits: 4 })} ETH`;
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const pct = (part, whole) => (whole === 0n ? 100 : Number((part * 10000n) / whole) / 100);

/**
 * Apply one decoded vault event to `state` (mutated) and return the alerts it raises.
 * `ev` = { name, args, blockNumber, logIndex, txHash, timestamp }.
 */
function evaluate(state, ev, cfg = DEFAULTS) {
  const c = { ...DEFAULTS, ...cfg };
  const t = Number(ev.timestamp);
  const alerts = [];
  const raise = (rule, severity, message, extra = {}) =>
    alerts.push({ id: `${rule}:${ev.txHash}:${ev.logIndex}`, rule, severity, message, blockNumber: Number(ev.blockNumber), txHash: ev.txHash, time: t, ...extra });
  const isAdmin = (a) => inList(c.knownAdmins, a) || inList(c.approvedOwners, a);
  const checkActor = (by, what) => {
    if (!isAdmin(by)) raise("UNKNOWN_ADMIN", "critical", `${what} by ${short(by)}, which is not a known admin`);
  };
  const muted = (rule) => (state.mutedUntil[rule] || 0) > t;
  const mute = (rule, sec) => { state.mutedUntil[rule] = t + sec; };
  const a = ev.args;

  switch (ev.name) {
    case "Deposited": {
      state.total = a.totalAfter;
      state.counts.deposits++;
      const day = Math.floor(t / 86400);
      if (day !== state.day) { state.day = day; state.inToday = 0n; state.outToday = 0n; }
      state.inToday += a.amount;
      break;
    }

    case "Withdrawn": {
      state.counts.withdrawals++;
      const before = a.totalAfter + a.amount;
      state.total = a.totalAfter;

      // 1. one big withdrawal
      if (a.amount >= c.largeMinWei && a.amount * 100n >= BigInt(c.largePct) * before) {
        raise("LARGE_WITHDRAWAL", "high", `${short(a.user)} withdrew ${eth(a.amount)}, ${pct(a.amount, before)}% of the vault`);
      }

      // 2. many smaller withdrawals adding up (split across one or many addresses)
      state.window.push({ t, amount: a.amount });
      state.window = state.window.filter((w) => w.t > t - c.windowSec);
      const out = state.window.reduce((s, w) => s + w.amount, 0n);
      const atStart = a.totalAfter + out; // the vault before this window's withdrawals
      // One alert per episode, BUT a muted alert fires again when the outflow doubles (F-2):
      // a small first spike must not hide a much bigger drain in the same hour.
      const escalated = muted("OUTFLOW_SPIKE") && out >= state.spikeOut * 2n;
      // At least 2 withdrawals: one member taking their own ETH is LARGE_WITHDRAWAL (high), not a reason
      // to pause everyone (F-4). This rule is for drains spread over many transactions or addresses.
      if ((!muted("OUTFLOW_SPIKE") || escalated) && state.window.length >= 2 && out >= c.windowMinWei && out * 100n >= BigInt(c.windowPct) * atStart) {
        raise("OUTFLOW_SPIKE", "critical", `${eth(out)} (${pct(out, atStart)}% of the vault) left in ${state.window.length} withdrawals within ${c.windowSec / 60} min${escalated ? " — still growing" : ""}`, { outWei: out.toString() });
        mute("OUTFLOW_SPIKE", c.windowSec);
        state.spikeOut = out;
      }

      // 3. a burst of withdrawals, whatever the size
      const recent = state.window.filter((w) => w.t > t - c.burstSec).length;
      if (!muted("WITHDRAWAL_BURST") && recent >= c.burstCount) {
        raise("WITHDRAWAL_BURST", "medium", `${recent} withdrawals within ${c.burstSec / 60} min`);
        mute("WITHDRAWAL_BURST", c.burstSec);
      }

      // 4. the on-chain daily limit is nearly used up (the same UTC day the contract uses)
      const day = Math.floor(t / 86400);
      if (day !== state.day) { state.day = day; state.inToday = 0n; state.outToday = 0n; }
      const net = (x) => (x > state.inToday ? x - state.inToday : 0n); // net outflow, like the contract
      const prev = net(state.outToday);
      state.outToday += a.amount;
      const now = net(state.outToday);
      if (state.dailyLimit > 0n) {
        const line = (state.dailyLimit * BigInt(c.limitNearPct)) / 100n;
        if (prev < line && now >= line) {
          raise("DAILY_LIMIT_NEAR", "medium", `${eth(now)} of the ${eth(state.dailyLimit)} daily limit used today (net)`);
        }
      }
      break;
    }

    case "ChangeQueued": {
      state.counts.admin++;
      const kind = KINDS[Number(a.kind)] || `Kind${a.kind}`;
      state.pending[kind] = { value: a.value, eta: Number(a.eta) };
      checkActor(a.by, `${kind} change queued`);
      const shown = kind === "Guardian" ? short(getAddress(`0x${a.value.toString(16).padStart(40, "0")}`)) : eth(a.value);
      const approved = c.approvedChanges.some((x) => x.kind === kind && BigInt(x.value) === a.value);
      if (approved) {
        raise("ADMIN_CHANGE", "info", `Planned ${kind} change queued: ${shown}, executes after ${new Date(Number(a.eta) * 1000).toISOString()}`);
      } else {
        raise("UNANNOUNCED_CHANGE", "critical", `${kind} → ${shown} was queued but never announced; it can execute after ${new Date(Number(a.eta) * 1000).toISOString()}`, { kind: Number(a.kind), value: a.value.toString(), eta: Number(a.eta) });
      }
      break;
    }

    case "ChangeCancelled": {
      state.counts.admin++;
      const kind = KINDS[Number(a.kind)];
      delete state.pending[kind];
      checkActor(a.by, `${kind} change cancelled`);
      raise("ADMIN_CHANGE", "info", `${kind} change cancelled by ${short(a.by)}`);
      break;
    }

    case "ChangeExecuted": {
      state.counts.admin++;
      const kind = KINDS[Number(a.kind)];
      delete state.pending[kind];
      if (kind === "DailyLimit") state.dailyLimit = a.newValue;
      else state.guardian = getAddress(`0x${a.newValue.toString(16).padStart(40, "0")}`);
      checkActor(a.by, `${kind} change executed`);
      raise("ADMIN_CHANGE", "medium", `${kind} change executed by ${short(a.by)}`);
      break;
    }

    case "Paused":
      state.counts.admin++;
      state.paused = true;
      checkActor(a.account, "Vault paused");
      raise("PAUSED", "high", `Vault paused by ${short(a.account)}`);
      break;

    case "Unpaused":
      state.counts.admin++;
      state.paused = false;
      checkActor(a.account, "Vault unpaused");
      raise("UNPAUSED", "high", `Vault unpaused by ${short(a.account)}`);
      break;

    case "OwnershipTransferStarted":
      state.counts.admin++;
      if (inList(c.approvedOwners, a.newOwner)) raise("OWNERSHIP", "info", `Planned ownership transfer to ${short(a.newOwner)} started`);
      else raise("OWNERSHIP", "critical", `Ownership transfer to unknown address ${short(a.newOwner)} started`);
      break;

    case "OwnershipTransferred":
      state.owner = getAddress(a.newOwner);
      if (a.previousOwner === "0x0000000000000000000000000000000000000000") break; // deployment
      state.counts.admin++;
      if (inList(c.approvedOwners, a.newOwner) || inList(c.knownAdmins, a.newOwner)) raise("OWNERSHIP", "medium", `Ownership moved to ${short(a.newOwner)} (planned)`);
      else raise("OWNERSHIP", "critical", `Ownership moved to unknown address ${short(a.newOwner)}`);
      break;

    default:
      break; // events we don't know are ignored, never guessed at
  }
  return alerts;
}

module.exports = { evaluate, initialState, DEFAULTS, KINDS, SEVERITY };
