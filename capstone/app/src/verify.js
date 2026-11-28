// Pramaan verifier page: scan (or paste) a certificate's QR code and get the answer from the chain.
// Free and read-only: no wallet, no account. Everything shown is set with textContent, never HTML.
import jsQR from "jsqr";
import { ABI, STATUS, loadConfig, readClient } from "./chain.js";
import { FIELDS, REASON } from "../../lib/pramaan.js";
import { checkInputs, decodePayload, payloadFromLink } from "./codec.js";

const $ = (id) => document.getElementById(id);
const LABEL = { certNo: "Certificate no.", name: "Name", dateOfBirth: "Date of birth", program: "Programme", result: "Result", issuedOn: "Issued on (paper)" };
const ANSWER = {
  Valid: ["valid", "VALID", "Published by this institution, unchanged and not withdrawn. Compare every detail below with the paper."],
  Revoked: ["revoked", "REVOKED", "The institution withdrew this certificate."],
  Distrusted: ["distrusted", "DISTRUSTED", "Published with a key that was stolen at the time. Do not accept it; ask the institution to re-issue it."],
  Unknown: ["unknown", "NOT FOUND", "No institution published this certificate, or its details were changed. Treat it as fake."],
};

let cfg, client;

function show(kind, title, text) {
  const box = $("answer");
  box.hidden = false;
  box.className = `answer ${kind}`;
  $("answer-title").textContent = title;
  $("answer-text").textContent = text;
}

function row(table, k, v) {
  const tr = table.insertRow();
  tr.insertCell().textContent = k;
  tr.insertCell().textContent = v;
}

async function check(payloadText, scannedLink) {
  document.body.dataset.status = "checking";
  const s = await answer(payloadText, scannedLink);
  document.body.dataset.status = s;
  return s;
}

async function answer(payloadText, scannedLink) {
  $("details").replaceChildren();
  $("warning").hidden = true;
  let p;
  try {
    p = decodePayload(payloadFromLink(payloadText));
  } catch {
    show("unknown", "NOT A PRAMAAN QR CODE", "This code does not hold a Pramaan certificate. Treat the paper as unverified.");
    return "Unknown";
  }
  // Anti-phishing: a QR that sends people to another website is suspicious even if the certificate is real.
  if (scannedLink && /^https?:/i.test(scannedLink)) {
    const host = new URL(scannedLink).host;
    if (host !== location.host) {
      $("warning").hidden = false;
      $("warning").textContent = `Warning: this QR code points to another website (${host}). The real Pramaan checker is ${location.host}. The answer below comes from the real checker.`;
    }
  }
  show("checking", "CHECKING…", "Asking the blockchain.");
  let status, issuedAt, reason, inst;
  try {
    client ||= await readClient(cfg);
    const { serial, docHash } = checkInputs(p);
    // F-5: the institution is the batch's owner ON-CHAIN. The id in the QR is only a claim: if it
    // differs, a rogue college is passing its own batch off as another institution's → Unknown.
    const [, batchIssuer] = await client.readContract({ address: cfg.contract, abi: ABI, functionName: "batches", args: [BigInt(p.batchId)] });
    if (Number(batchIssuer) !== p.issuerId) {
      status = 0;
    } else {
      [status, issuedAt, reason] = await client.readContract({ address: cfg.contract, abi: ABI, functionName: "verifyInBatch", args: [BigInt(p.batchId), serial, docHash, p.proof] });
      inst = await client.readContract({ address: cfg.contract, abi: ABI, functionName: "issuers", args: [Number(batchIssuer)] });
    }
  } catch (e) {
    client = undefined;
    // An outage is NOT a fake certificate: say we could not check.
    show("error", "COULD NOT CHECK", `The blockchain could not be reached (${e.shortMessage || e.message}). Try again later; this says nothing about the certificate.`);
    return "Error";
  }
  const name = STATUS[status];
  const [kind, title, text] = ANSWER[name];
  show(kind, title, name === "Revoked" ? `${text} Reason: ${REASON[reason] || `code ${reason}`}.` : text);
  const t = $("details");
  if (name !== "Unknown") {
    row(t, "Issued by", inst[3]); // the name registered on-chain by the council, never the name in the QR
    row(t, "Published", new Date(Number(issuedAt) * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC");
    if (!inst[2]) row(t, "Note", "This institution is currently suspended. Certificates it issued before stay as shown.");
    for (const f of FIELDS) row(t, LABEL[f], p.cert[f]);
    row(t, "Batch · network", `#${p.batchId} · ${cfg.networkName} · ${cfg.contract}`);
  }
  return name;
}

function readQrImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height)); // phone photos are huge
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      const code = jsQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
      code ? resolve(code.data) : reject(new Error("no QR code found in the photo"));
    };
    img.onerror = () => reject(new Error("that file is not an image"));
    img.src = URL.createObjectURL(file);
  });
}

async function main() {
  try {
    cfg = await loadConfig();
  } catch (e) {
    show("error", "SITE NOT SET UP", e.message);
    return;
  }
  $("network").textContent = `${cfg.networkName} · contract ${cfg.contract}`;
  $("qr-file").addEventListener("change", async (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    try {
      const text = await readQrImage(f);
      await check(text, text);
    } catch (e) {
      show("error", "COULD NOT READ THE QR CODE", `${e.message}. Try a sharper photo, or paste the link.`);
    }
  });
  $("paste-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const v = $("paste").value;
    check(v, v);
  });
  const run = () => location.hash.startsWith("#c=") && check(location.hash.slice(3), null);
  window.addEventListener("hashchange", run);
  await run();
  document.body.dataset.ready = "1";
}

main();
