// Live feed: polls /api/feed every second and redraws the list.
// Every piece of on-chain data (task text above all) is user-controlled, so it
// is only ever written with textContent — never innerHTML.
"use strict";

const $ = (id) => document.getElementById(id);
const seen = new Set();
let firstLoad = true;

function short(addr) { return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "?"; }

/** wei (as a decimal string) → "1.5 ETH", exact, no floating point. */
function eth(wei) {
  const v = BigInt(wei);
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "").slice(0, 6);
  return `${whole}${frac ? "." + frac : ""} ETH`;
}

function date(sec) { return new Date(Number(sec) * 1000).toISOString().slice(0, 10); }

function describe(ev) {
  const a = ev.args;
  switch (ev.event) {
    case "TaskAdded": return ["📝", `added task #${a.id}: “${a.text}”`];
    case "TaskCompleted": return ["✅", `completed task #${a.id}`];
    case "TaskDeleted": return ["🗑️", `deleted task #${a.id}`];
    case "Deposited": return ["🐷", `locked ${eth(a.amount)} until ${date(a.unlockAt)} (now ${eth(a.newBalance)})`];
    case "LockExtended": return ["⏳", `extended the lock to ${date(a.newUnlockAt)}`];
    case "Withdrawn": return ["💸", `withdrew ${eth(a.amount)}`];
    default: return ["•", ev.event];
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function row(ev, confirmations) {
  const [icon, what] = describe(ev);
  const li = el("li");
  li.dataset.id = ev.id;
  li.appendChild(el("span", "icon", icon));
  const w = el("span", "what");
  w.appendChild(el("span", "who", short(ev.args.owner)));
  w.appendChild(document.createTextNode(" " + what));
  li.appendChild(w);
  const label = ev.status === "confirmed" ? "confirmed" : `pending ${ev.confirmations}/${confirmations}`;
  li.appendChild(el("span", `badge ${ev.status}`, label));
  li.appendChild(el("span", "meta", `${ev.contract} · block ${ev.blockNumber} · tx ${ev.txHash.slice(0, 10)}…`));
  if (!firstLoad && !seen.has(ev.id)) li.classList.add("new");
  return li;
}

function render(data) {
  $("chain").textContent = data.chainId ?? "–";
  $("head").textContent = data.head ?? "–";
  $("cursor").textContent = data.cursor ?? "–";
  $("total").textContent = data.total;

  const list = $("feed");
  list.replaceChildren(...data.events.map((ev) => row(ev, data.confirmations)));
  data.events.forEach((ev) => seen.add(ev.id));
  $("empty").hidden = data.events.length > 0;

  const box = $("reorg");
  const r = data.reorgs[0];
  if (r && Date.now() - r.at < 5 * 60 * 1000) {
    box.replaceChildren(el("b", null, `Chain reorganisation from block ${r.fromBlock}: ${r.removed} event(s) removed.`));
    for (const ev of r.removedEvents) {
      box.appendChild(el("div")).appendChild(el("s", null, `${short(ev.args.owner)} ${describe(ev)[1]}`));
    }
    box.hidden = false;
  } else box.hidden = true;

  const err = $("error");
  err.hidden = !data.status.error;
  err.textContent = data.status.error ? `Indexer can't reach the chain: ${data.status.error}` : "";
  firstLoad = false;
}

async function poll() {
  try {
    const res = await fetch("/api/feed", { cache: "no-store" });
    render(await res.json());
    $("sync").textContent = "live";
    $("sync").classList.remove("down");
  } catch {
    $("sync").textContent = "feed server offline";
    $("sync").classList.add("down");
  }
  setTimeout(poll, 1000);
}
poll();
