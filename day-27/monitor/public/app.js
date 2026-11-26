// Day 27 dashboard: polls /api/state every second. All text is set with textContent,
// never innerHTML, so nothing from the chain can become HTML or script.
const $ = (id) => document.getElementById(id);
const eth = (wei) => `${(Number(BigInt(wei) / 10n ** 14n) / 10000).toLocaleString("en-US")} ETH`;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = String(text);
  return e;
}

function render(s) {
  const st = s.state;
  if (!st) return;
  $("tvl").textContent = eth(st.total);
  // same maths as the contract: limit + today's deposits − today's withdrawals (chain time, not the PC clock)
  const sameDay = Math.floor(s.headTime / 86400) === st.day;
  const cap = BigInt(st.dailyLimit) + (sameDay ? BigInt(st.inToday) : 0n);
  const out = sameDay ? BigInt(st.outToday) : 0n;
  $("limit").textContent = `${eth(out >= cap ? 0n : cap - out)} of ${eth(st.dailyLimit)}`;
  $("paused").textContent = st.paused ? "PAUSED" : "open";
  $("paused").className = st.paused ? "bad" : "good";
  const open = s.alerts.filter((a) => a.severity === "critical" || a.severity === "high").length;
  $("open").textContent = String(open);

  const pend = $("pending");
  pend.replaceChildren();
  const kinds = Object.entries(st.pending || {});
  if (!kinds.length) pend.append(el("li", "muted", "none"));
  for (const [kind, p] of kinds) pend.append(el("li", "", `${kind} → ${kind === "DailyLimit" ? eth(p.value) : "0x" + BigInt(p.value).toString(16).padStart(40, "0")} · executes after ${new Date(p.eta * 1000).toISOString()}`));

  const body = $("alerts");
  body.replaceChildren();
  if (!s.alerts.length) {
    const tr = el("tr");
    const td = el("td", "muted", "No alerts yet");
    td.colSpan = 5;
    tr.append(td);
    body.append(tr);
  }
  for (const a of s.alerts.slice(0, 100)) {
    const tr = el("tr", `sev-${a.severity}`);
    tr.append(el("td", "sev", a.severity), el("td", "rule", a.rule), el("td", "msg", a.message), el("td", "resp", a.response || "–"), el("td", "", a.blockNumber));
    body.append(tr);
  }
  $("meta").textContent = `Vault ${s.vault} · block ${s.head} · checked up to ${s.cursor} (${s.confirmations} confirmations) · ${st.counts.deposits} deposits, ${st.counts.withdrawals} withdrawals, ${st.counts.admin} admin events`;
}

async function tick() {
  try {
    const r = await fetch("/api/state", { cache: "no-store" });
    const s = await r.json();
    render(s);
    $("status").textContent = s.lastError ? `RPC error: ${s.lastError}` : "live";
    $("status").className = s.lastError ? "pill bad" : "pill good";
  } catch {
    $("status").textContent = "monitor offline";
    $("status").className = "pill bad";
  }
}
tick();
setInterval(tick, 1000);
