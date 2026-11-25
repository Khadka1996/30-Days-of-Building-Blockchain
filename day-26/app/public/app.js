// Day 26 — the two-chains page. Plain browser JavaScript, no build step.
// All text from the server is shown with textContent (never innerHTML).
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const usd = (x) => (x >= 0.01 ? "$" + x.toFixed(2) : "$" + x.toFixed(4));

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function status(text, isError) { $("status").textContent = text; $("status").className = isError ? "error" : ""; }

  let costsDrawn = false;
  function render(s) {
    for (const k of ["l1", "l2"]) { $(k + "-id").textContent = s.chains[k].chainId; $(k + "-block").textContent = s.chains[k].block; }
    if (!costsDrawn) {
      $("prices").textContent = `Real gas and real transaction size from this run, priced at L1 ${s.prices.l1GasPriceGwei} gwei, L2 ${s.prices.l2GasPriceGwei} gwei + L1 data fee, ETH $${s.prices.ethUsd}.`;
      const body = $("costs").querySelector("tbody");
      for (const r of s.costs) {
        const tr = el("tr");
        tr.append(el("td", "", r.action), el("td", "n", r.gas.toLocaleString("en-US")), el("td", "n", usd(r.l1Usd)), el("td", "n", usd(r.l2Usd)), el("td", "n win", Math.round(r.times) + "×"));
        body.append(tr);
      }
      costsDrawn = true;
    }
    const list = $("messages");
    list.replaceChildren(...s.messages.map((m) => {
      const li = el("li", m.status === "delivered" ? "delivered" : "");
      li.dataset.id = m.id;
      li.append(el("span", "s", m.from.toUpperCase() + " → " + m.to.toUpperCase()), el("span", "t", m.text),
        el("span", "s", m.status === "delivered" ? "delivered · " + m.deliveredGas.toLocaleString("en-US") + " gas" : m.status));
      return li;
    }));
    for (const k of ["l1", "l2"]) $("tasks-" + k).replaceChildren(...s.tasks[k].map((t) => el("li", "", t)));
  }

  async function refresh() {
    try { const r = await fetch("/api/state"); if (r.ok) render(await r.json()); } catch { /* server stopped */ }
  }

  $("send").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("go").disabled = true;
    try {
      const res = await fetch("/api/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: $("text").value, direction: $("direction").value }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || "HTTP " + res.status);
      status(`Sent as message #${j.nonce}. Waiting for 2 confirmations…`);
      $("text").value = "";
      await refresh();
    } catch (err) { status(err.message, true); } finally { $("go").disabled = false; }
  });

  refresh();
  setInterval(refresh, 1000);
})();
