// Browser side of "Sign in with Ethereum". Bundled to public/app.js by esbuild
// (`npm run build:web`) so it can use viem's EIP-4361 helpers.
import { createSiweMessage } from "viem/siwe";
import { getAddress, toHex } from "viem";

const $ = (id) => document.getElementById(id);

function show(state) {
  $("signed-out").hidden = state !== "out";
  $("signed-in").hidden = state !== "in";
}

function status(text, kind = "info") {
  const el = $("status");
  el.textContent = text; // textContent only: nothing from a wallet or server is ever parsed as HTML
  el.className = kind;
}

async function api(path, body) {
  const res = await fetch(path, body === undefined
    ? { credentials: "same-origin" }
    : { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

async function renderMe() {
  try {
    const me = await api("/api/me");
    $("who").textContent = me.address;
    $("until").textContent = new Date(me.expiresAt).toLocaleTimeString();
    const list = $("tasks");
    list.replaceChildren();
    if (me.tasks === null) list.append(Object.assign(document.createElement("li"), { textContent: "Can't reach the chain right now." }));
    else if (me.tasks.length === 0) list.append(Object.assign(document.createElement("li"), { textContent: "No tasks yet." }));
    for (const t of me.tasks || []) {
      const li = document.createElement("li");
      li.textContent = `${t.completed ? "✔" : "○"} #${t.id} ${t.text}`;
      list.append(li);
    }
    show("in");
    return true;
  } catch {
    show("out");
    return false;
  }
}

async function signIn() {
  const eth = window.ethereum;
  if (!eth) return status("No wallet found. Install a browser wallet such as MetaMask.", "error");
  $("login").disabled = true;
  try {
    status("Connecting to your wallet…");
    const [account] = await eth.request({ method: "eth_requestAccounts" });
    if (!account) throw new Error("No account");
    const address = getAddress(account); // wallets often return lower case; EIP-4361 needs the checksum form

    const { nonce, chainId, statement } = await api("/api/nonce");
    const walletChain = Number(await eth.request({ method: "eth_chainId" }));
    if (walletChain !== chainId) return status(`Your wallet is on chain ${walletChain}. Switch it to chain ${chainId} and try again.`, "error");

    const issuedAt = new Date();
    const message = createSiweMessage({
      domain: window.location.host, // must be the site you are on: your wallet checks it, and so does the server
      address,
      statement,
      uri: window.location.origin,
      version: "1",
      chainId,
      nonce,
      issuedAt,
      expirationTime: new Date(issuedAt.getTime() + 10 * 60 * 1000),
    });

    status("Check your wallet and sign the message (it is free, no transaction).");
    const signature = await eth.request({ method: "personal_sign", params: [toHex(message), account] });
    await api("/api/login", { message, signature });
    status("Signed in.", "ok");
    await renderMe();
  } catch (e) {
    if (e && e.code === 4001) status("You cancelled the signature. Nothing was sent.", "error");
    else status(e.message || "Sign-in failed", "error");
  } finally {
    $("login").disabled = false;
  }
}

async function signOut() {
  await api("/api/logout", {}).catch(() => {});
  status("Signed out.");
  show("out");
}

$("login").addEventListener("click", signIn);
$("logout").addEventListener("click", signOut);
renderMe();
