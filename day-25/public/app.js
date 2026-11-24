// Day 25 — the gasless to-do page. Plain browser JavaScript, no build step.
// The wallet only SIGNS (eth_signTypedData_v4, free). The relayer sends the
// transaction and pays the gas. Task text is always shown with textContent.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let cfg, account;

  function status(text, isError = false) {
    $("status").textContent = text;
    $("status").className = isError ? "error" : "";
  }

  async function api(path, body) {
    const res = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  }

  // ---- tiny ABI encoder for our 3 functions (selector + arguments) ----
  const hex32 = (n) => BigInt(n).toString(16).padStart(64, "0");
  function encodeString(s) {
    const bytes = new TextEncoder().encode(s);
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return hex32(32) + hex32(bytes.length) + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
  }
  const callData = {
    addTask: (text) => cfg.selectors.addTask + encodeString(text),
    completeTask: (id) => cfg.selectors.completeTask + hex32(id),
    deleteTask: (id) => cfg.selectors.deleteTask + hex32(id),
  };

  async function chainIsRight() {
    const id = parseInt(await window.ethereum.request({ method: "eth_chainId" }), 16);
    if (id !== cfg.chainId) {
      status(`Wrong network (chain ${id}). Switch your wallet to chain ${cfg.chainId}.`, true);
      return false;
    }
    return true;
  }

  /** Sign a ForwardRequest for `data` and hand it to the relayer. */
  async function act(fn, arg, label) {
    const buttons = document.querySelectorAll("button");
    buttons.forEach((b) => { b.disabled = true; });
    try {
      if (!(await chainIsRight())) return;
      const { nonce } = await api(`/api/account/${account}`);
      const request = {
        from: account, to: cfg.todo, value: "0", gas: "200000", nonce,
        deadline: String(Math.floor(Date.now() / 1000) + 600), // 10 minutes
        data: "0x" + callData[fn](arg).slice(2),
      };
      const typedData = { domain: cfg.domain, types: { EIP712Domain: [
        { name: "name", type: "string" }, { name: "version", type: "string" },
        { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
      ], ...cfg.types }, primaryType: "ForwardRequest", message: request };
      status("Check your wallet: sign the request (free, no gas)…");
      let signature;
      try {
        signature = await window.ethereum.request({ method: "eth_signTypedData_v4", params: [account, JSON.stringify(typedData)] });
      } catch (e) {
        status(e && e.code === 4001 ? "You cancelled the signature. Nothing was sent." : `Wallet error: ${e.message}`, true);
        return;
      }
      status("Relayer is sending it…");
      const r = await api("/api/relay", { request, signature });
      status(`${label}: done in block ${r.blockNumber}. The relayer paid ${r.gasUsed} gas, you paid 0.`);
      await refresh();
    } catch (e) {
      status(`Refused: ${e.message}`, true);
    } finally {
      buttons.forEach((b) => { b.disabled = false; });
    }
  }

  async function refresh() {
    const acc = await api(`/api/account/${account}`);
    $("who").textContent = acc.address;
    $("balance").textContent = (Number(BigInt(acc.balance) / 10n ** 12n) / 1e6).toString();
    $("nonce").textContent = acc.nonce;
    const list = $("tasks");
    list.replaceChildren();
    for (const t of acc.tasks) {
      const li = document.createElement("li");
      if (t.completed) li.className = "done";
      const span = document.createElement("span");
      span.textContent = t.text;
      li.append(span);
      if (!t.completed) {
        const done = document.createElement("button");
        done.className = "ghost"; done.textContent = "Done";
        done.addEventListener("click", () => act("completeTask", t.id, "Completed"));
        li.append(done);
      }
      const del = document.createElement("button");
      del.className = "ghost"; del.textContent = "Delete";
      del.addEventListener("click", () => act("deleteTask", t.id, "Deleted"));
      li.append(del);
      list.append(li);
    }
  }

  $("connect").addEventListener("click", async () => {
    if (!window.ethereum) return status("No wallet found. Install MetaMask.", true);
    try {
      cfg = await api("/api/config");
      const [a] = await window.ethereum.request({ method: "eth_requestAccounts" });
      account = a;
      if (!(await chainIsRight())) return;
      $("signed-out").hidden = true;
      $("app").hidden = false;
      status("");
      await refresh();
    } catch (e) {
      status(e && e.code === 4001 ? "You cancelled the connection." : `Could not connect: ${e.message}`, true);
    }
  });

  $("add").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const text = $("text").value.trim();
    if (!text) return;
    act("addTask", text, "Added").then(() => { if (!$("status").classList.contains("error")) $("text").value = ""; });
  });
})();
