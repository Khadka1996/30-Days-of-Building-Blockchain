// Shared test setup: the in-process Hardhat chain, a viem client over it, the
// auth server, and a tiny "browser" (fetch + cookie jar) to talk to it.
const { ethers, network, artifacts } = require("hardhat");
const { createPublicClient, custom } = require("viem");
const { createSiweMessage } = require("viem/siwe");
const { createAuthServer } = require("../auth/server");

const CHAIN_ID = 31337;

function viemClient() {
  return createPublicClient({
    transport: custom({ request: ({ method, params }) => network.provider.request({ method, params }) }, { retryCount: 0 }),
    cacheTime: 0,
  });
}

async function deploy() {
  const signers = await ethers.getSigners();
  const todo = await ethers.deployContract("TodoList");
  const wallet = await ethers.deployContract("SmartWallet", [signers[1].address]);
  const todoInfo = { address: await todo.getAddress(), abi: (await artifacts.readArtifact("TodoList")).abi };
  return { todo, wallet, todoInfo, signers };
}

async function startServer(env, opts = {}) {
  const app = createAuthServer({ client: viemClient(), chainId: CHAIN_ID, todo: env.todoInfo, ...opts });
  const port = await app.listen(0);
  app.base = `http://127.0.0.1:${port}`;
  return app;
}

/** A browser: keeps its own cookies and sends our Origin header like a real page would. */
class Browser {
  constructor(base, origin = base) { this.base = base; this.origin = origin; this.jar = {}; }
  async req(path, { method = "GET", body, headers = {}, raw } = {}) {
    const h = { ...headers };
    const cookie = Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookie) h.cookie = cookie;
    if (method !== "GET" && this.origin && !("origin" in h)) h.origin = this.origin;
    if (body !== undefined && !("content-type" in h)) h["content-type"] = "application/json";
    for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
    const res = await fetch(this.base + path, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [k, v] = [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)];
      if (v === "" || /Max-Age=0/.test(c)) delete this.jar[k]; else this.jar[k] = v;
    }
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, json, headers: res.headers, setCookies: res.headers.getSetCookie() };
  }
  nonce() { return this.req("/api/nonce"); }
  login(message, signature, extra) { return this.req("/api/login", { method: "POST", body: { message, signature }, ...extra }); }
  me() { return this.req("/api/me"); }
  logout() { return this.req("/api/logout", { method: "POST", body: {} }); }
}

/** Build the message the real page would build, with optional overrides. */
function buildMessage(app, address, nonce, over = {}) {
  const now = new Date(app.config.now());
  return createSiweMessage({
    domain: new URL(app.base).host,
    address,
    statement: app.config.statement,
    uri: app.base,
    version: "1",
    chainId: CHAIN_ID,
    nonce,
    issuedAt: now,
    expirationTime: new Date(now.getTime() + 10 * 60 * 1000),
    ...over,
  });
}

/** Full happy-path sign-in for `signer` in `browser`. Returns { message, signature, res }. */
async function signIn(app, browser, signer, over = {}, address = signer.address) {
  const { json } = await browser.nonce();
  const message = buildMessage(app, address, json.nonce, over);
  const signature = await signer.signMessage(message);
  const res = await browser.login(message, signature);
  return { message, signature, res, nonce: json.nonce };
}

const snapshot = () => network.provider.send("evm_snapshot");
const revert = (id) => network.provider.send("evm_revert", [id]);

module.exports = { CHAIN_ID, viemClient, deploy, startServer, Browser, buildMessage, signIn, snapshot, revert };
