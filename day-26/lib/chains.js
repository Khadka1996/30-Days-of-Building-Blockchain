// Day 26 — start two real local chains: "L1" and an "L2-style" chain.
// Each one is a separate `hardhat node` process with its own chain ID and port,
// so they have separate state, separate blocks and separate chain IDs, just
// like two real networks.
const { spawn } = require("node:child_process");
const path = require("node:path");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
const MNEMONIC = "test test test test test test test test test test test junk"; // Hardhat's public dev mnemonic

const L1 = { name: "L1", chainId: 31337, port: 8545 };
const L2 = { name: "L2", chainId: 31338, port: 8546 };

/** Dev account #i (public test key — never use on a real network). */
function devWallet(i, provider) {
  return ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`).connect(provider);
}

async function waitForRpc(url, chainId, child, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`chain on ${url} exited early`);
    try {
      const res = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      const j = await res.json();
      if (Number(j.result) === chainId) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`chain on ${url} did not start`);
}

/** Start one chain. Returns { ...spec, url, provider, stop() }. */
async function startChain(spec, { quiet = true } = {}) {
  const bin = path.join(ROOT, "node_modules", ".bin", "hardhat");
  const child = spawn(bin, ["node", "--hostname", "127.0.0.1", "--port", String(spec.port)], {
    cwd: ROOT,
    env: { ...process.env, CHAIN_ID: String(spec.chainId) },
    stdio: quiet ? "ignore" : "inherit",
  });
  const url = `http://127.0.0.1:${spec.port}`;
  await waitForRpc(url, spec.chainId, child);
  const provider = new ethers.JsonRpcProvider(url, spec.chainId, { staticNetwork: true, pollingInterval: 50, cacheTimeout: -1 });
  return {
    ...spec, url, provider,
    stop: () => new Promise((resolve) => {
      provider.destroy();
      if (child.exitCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    }),
  };
}

/** Start L1 and L2 (optionally on other ports, e.g. for tests). */
async function startChains({ l1Port = L1.port, l2Port = L2.port, quiet = true } = {}) {
  const [l1, l2] = await Promise.all([
    startChain({ ...L1, port: l1Port }, { quiet }),
    startChain({ ...L2, port: l2Port }, { quiet }),
  ]);
  return { l1, l2, stop: () => Promise.all([l1.stop(), l2.stop()]) };
}

module.exports = { L1, L2, MNEMONIC, devWallet, startChain, startChains };
