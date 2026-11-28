// Pramaan institution portal: upload a CSV of results → one Merkle root → publish with the
// institution's wallet → download the certificate pack (verify links for the QR codes).
// All hashing happens in this browser. The CSV, the names and the salts are never uploaded:
// the only thing that leaves is one transaction with the root and the count.
import QRCode from "qrcode";
import { ABI, batchIdFromReceipt, connectWallet, explain, institutionOf, loadConfig, readClient, switchChain } from "./chain.js";
import { FIELDS, buildBatch, docHashOf, newSalt, serialOf } from "../../lib/pramaan.js";
import { encodePayload, readResults, toCsv, verifyLink } from "./codec.js";

const $ = (id) => document.getElementById(id);
let cfg, client, provider, session, prepared, backupSaved = false, busy = false;

function status(id, text, kind = "") {
  const el = $(id);
  el.textContent = text;
  el.className = `status ${kind}`;
}

function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** A local-only test wallet (Hardhat's unlocked accounts). Offered only when config.json lists devAccounts. */
function devProvider(address) {
  let id = 0;
  const rpc = async (method, params = []) => {
    const r = await fetch(cfg.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const j = await r.json();
    if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code, data: j.error.data });
    return j.result;
  };
  return {
    request: ({ method, params }) => (method === "eth_requestAccounts" || method === "eth_accounts" ? Promise.resolve([address]) : rpc(method, params)),
  };
}

function refreshButtons() {
  const ok = session?.rightChain && session.inst?.active;
  $("publish").disabled = busy || !ok || !prepared || !backupSaved;
  $("backup").disabled = !prepared;
  $("revoke").disabled = busy || !ok;
  $("restore").disabled = busy || !session?.inst;
}

// ───────────────────────────── 1. wallet ─────────────────────────────
async function connect(p) {
  provider = p;
  try {
    session = await connectWallet(cfg, provider);
  } catch (e) {
    status("wallet-status", explain(e), "bad");
    return;
  }
  $("account").textContent = session.account;
  $("switch").hidden = session.rightChain;
  if (!session.rightChain) {
    status("wallet-status", `Wrong network: your wallet is on chain ${session.chainId}. Pramaan runs on ${cfg.networkName} (chain ${cfg.chainId}).`, "bad");
    refreshButtons();
    return;
  }
  session.inst = await institutionOf(client, cfg, session.account);
  if (!session.inst) status("wallet-status", "This wallet is not a registered institution key. Only keys added by the council can publish.", "bad");
  else if (!session.inst.active) status("wallet-status", `${session.inst.name} is suspended by the council. Publishing is disabled.`, "bad");
  else status("wallet-status", `Connected as ${session.inst.name} (institution #${session.inst.id}).`, "good");
  refreshButtons();
}

// ───────────────────────────── 2. CSV → batch ─────────────────────────────
async function onCsv(file) {
  prepared = undefined;
  backupSaved = false;
  $("result").hidden = true;
  $("errors").replaceChildren();
  $("preview").replaceChildren();
  if (!session?.inst) {
    status("csv-status", "Connect an institution wallet first (the institution id goes into every hash).", "bad");
    return refreshButtons();
  }
  const { certs, errors } = readResults(await file.text());
  if (errors.length) {
    status("csv-status", `${errors.length} problem(s) found. Fix the file and upload it again; nothing was prepared.`, "bad");
    for (const e of errors.slice(0, 20)) $("errors").append(Object.assign(document.createElement("li"), { textContent: e }));
    return refreshButtons();
  }
  const issuerId = session.inst.id;
  const items = certs.map((cert) => {
    const salt = newSalt(); // 32 random bytes per certificate: nobody can guess the hash from public details
    return { cert, salt, serial: serialOf(cert.certNo), docHash: docHashOf(issuerId, cert, salt) };
  });
  const tree = buildBatch(issuerId, items);
  prepared = { issuerId, items, tree };
  const t = $("preview");
  const head = t.createTHead().insertRow();
  for (const f of FIELDS) head.insertCell().textContent = f;
  const tbody = t.createTBody();
  for (const it of items.slice(0, 5)) {
    const r = tbody.insertRow();
    for (const f of FIELDS) r.insertCell().textContent = it.cert[f];
  }
  $("root").textContent = tree.root;
  status("csv-status", `${items.length} certificates ready. Root: ${tree.root.slice(0, 18)}… Download the backup, then publish.`, "good");
  refreshButtons();
}

function backupJson() {
  const { issuerId, items, tree } = prepared;
  return JSON.stringify({ pramaanBackup: 1, chainId: cfg.chainId, contract: cfg.contract, issuerId, root: tree.root, count: items.length, certs: items.map((it) => ({ ...it.cert, salt: it.salt })) }, null, 1);
}

// ───────────────────────────── 3. publish ─────────────────────────────
async function publish() {
  if (busy || !prepared || !backupSaved) return;
  busy = true; // one click = one transaction, even if the button is clicked twice
  refreshButtons();
  const { tree, items } = prepared;
  try {
    status("publish-status", "Check your wallet and confirm the transaction…");
    const args = [tree.root, items.length];
    // Simulate first: a contract error shows here, before the wallet asks for gas.
    await client.simulateContract({ address: cfg.contract, abi: ABI, functionName: "issueBatch", args, account: session.account });
    const hash = await session.wallet.writeContract({ address: cfg.contract, abi: ABI, functionName: "issueBatch", args });
    status("publish-status", `Sent ${hash.slice(0, 12)}… waiting for the block.`);
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("the transaction failed");
    const batchId = batchIdFromReceipt(cfg, receipt, tree.root);
    status("publish-status", `Published: batch #${batchId}, ${items.length} certificates in one transaction (${receipt.gasUsed.toLocaleString("en")} gas).`, "good");
    await showPack(batchId, prepared);
    prepared = undefined; // never publish the same file twice
    backupSaved = false;
  } catch (e) {
    status("publish-status", explain(e), "bad");
  } finally {
    busy = false;
    refreshButtons();
  }
}

async function showPack(batchId, { issuerId, items, tree }) {
  const origin = cfg.siteUrl || location.origin;
  const rows = [[...FIELDS, "verifyLink"]];
  const links = items.map((it) => {
    const link = verifyLink(origin, encodePayload({ issuerId, batchId, cert: it.cert, salt: it.salt, proof: tree.proof(it.serial, it.docHash) }));
    rows.push([...FIELDS.map((f) => it.cert[f]), link]);
    return link;
  });
  const csv = toCsv(rows);
  $("pack").onclick = () => download(`pramaan-batch-${batchId}-pack.csv`, csv, "text/csv");
  $("batch-id").textContent = `#${batchId}`;
  const list = $("qrs");
  list.replaceChildren();
  for (let i = 0; i < Math.min(items.length, 6); i++) {
    const fig = document.createElement("figure");
    const img = new Image();
    img.src = await QRCode.toDataURL(links[i], { errorCorrectionLevel: "M", margin: 2, width: 220 });
    img.alt = `QR code for ${items[i].cert.certNo}`;
    const cap = document.createElement("figcaption");
    cap.textContent = items[i].cert.certNo;
    const a = Object.assign(document.createElement("a"), { href: links[i], textContent: "open", target: "_blank", rel: "noopener" });
    fig.append(img, cap, a);
    list.append(fig);
  }
  $("result").hidden = false;
}

// Lost the pack after publishing? Rebuild it from the backup, after checking the chain agrees.
async function restore() {
  try {
    const b = JSON.parse(await $("restore-file").files[0].text());
    const batchId = Number($("restore-batch").value);
    if (b.pramaanBackup !== 1 || b.chainId !== cfg.chainId || b.contract !== cfg.contract) throw new Error("this backup is for another network or contract");
    if (b.issuerId !== session.inst.id) throw new Error("this backup belongs to another institution");
    const [root, issuerId, count] = await client.readContract({ address: cfg.contract, abi: ABI, functionName: "batches", args: [BigInt(batchId)] });
    const items = b.certs.map(({ salt, ...rest }) => {
      const cert = Object.fromEntries(FIELDS.map((f) => [f, rest[f]]));
      return { cert, salt, serial: serialOf(cert.certNo), docHash: docHashOf(b.issuerId, cert, salt) };
    });
    const tree = buildBatch(b.issuerId, items);
    if (root !== tree.root || Number(issuerId) !== b.issuerId || Number(count) !== items.length) throw new Error(`batch #${batchId} on-chain does not match this backup`);
    await showPack(batchId, { issuerId: b.issuerId, items, tree });
    status("restore-status", `Pack rebuilt for batch #${batchId}.`, "good");
  } catch (e) {
    status("restore-status", e.message, "bad");
  }
}

// ───────────────────────────── 4. revoke ─────────────────────────────
async function revoke() {
  if (busy) return;
  busy = true;
  refreshButtons();
  try {
    const certNo = $("revoke-no").value;
    const reason = Number($("revoke-reason").value);
    const serial = serialOf(certNo);
    await client.simulateContract({ address: cfg.contract, abi: ABI, functionName: "revoke", args: [serial, reason], account: session.account });
    const hash = await session.wallet.writeContract({ address: cfg.contract, abi: ABI, functionName: "revoke", args: [serial, reason] });
    await client.waitForTransactionReceipt({ hash });
    status("revoke-status", `Certificate ${certNo.trim()} revoked. Every verifier now sees REVOKED.`, "good");
  } catch (e) {
    status("revoke-status", explain(e), "bad");
  } finally {
    busy = false;
    refreshButtons();
  }
}

async function main() {
  try {
    cfg = await loadConfig();
    client = await readClient(cfg);
  } catch (e) {
    status("wallet-status", `Site not ready: ${e.message}`, "bad");
    return;
  }
  $("network").textContent = `${cfg.networkName} · contract ${cfg.contract}`;
  $("connect").onclick = () => connect(window.ethereum);
  $("switch").onclick = async () => {
    try { await switchChain(cfg, provider); await connect(provider); } catch (e) { status("wallet-status", explain(e), "bad"); }
  };
  if (Array.isArray(cfg.devAccounts) && cfg.chainId === 31337) {
    $("dev").hidden = false;
    for (const d of cfg.devAccounts) $("dev-account").append(new Option(`${d.label} (${d.address.slice(0, 8)}…)`, d.address));
    $("dev-connect").onclick = () => connect(devProvider($("dev-account").value));
  }
  $("csv").addEventListener("change", (ev) => ev.target.files[0] && onCsv(ev.target.files[0]));
  $("backup").onclick = () => {
    download(`pramaan-backup-${prepared.tree.root.slice(2, 10)}.json`, backupJson(), "application/json");
    backupSaved = true;
    status("backup-status", "Backup downloaded. Keep it offline: it holds every salt. Without it, lost QR codes can't be rebuilt.", "good");
    refreshButtons();
  };
  $("publish").onclick = publish;
  $("revoke").onclick = revoke;
  $("restore").onclick = restore;
  refreshButtons();
  document.body.dataset.ready = "1";
}

main();
