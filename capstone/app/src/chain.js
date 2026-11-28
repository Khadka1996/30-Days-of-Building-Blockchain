// Pramaan web app — talking to the chain with viem.
// The verifier only READS through the site's own RPC (no wallet, no gas).
// The institution portal WRITES through the institution's wallet (EIP-1193, e.g. MetaMask).
import { createPublicClient, createWalletClient, custom, decodeEventLog, defineChain, getAddress, http, parseAbi } from "viem";

export const ABI = parseAbi([
  "function issuers(uint32) view returns (address key, uint64 keyActiveFrom, bool active, string name)",
  "function issuerOfKey(address) view returns (uint32)",
  "function batches(uint256) view returns (bytes32 root, uint32 issuerId, uint32 count, uint64 time, uint64 blockNo)",
  "function batchCount() view returns (uint256)",
  "function verifyInBatch(uint256 batchId, bytes32 serial, bytes32 docHash, bytes32[] proof) view returns (uint8 status, uint64 issuedAt, uint8 reason)",
  "function issueBatch(bytes32 root, uint32 count) returns (uint256)",
  "function revoke(bytes32 serial, uint8 reason)",
  "event BatchIssued(uint32 indexed issuerId, uint256 indexed batchId, bytes32 root, uint32 count)",
  "error NotIssuer()",
  "error IssuerSuspended(uint32 issuerId)",
  "error KeyNotActiveYet(uint64 fromBlock)",
  "error ZeroValue()",
  "error AlreadyRevoked()",
]);

export const STATUS = ["Unknown", "Valid", "Revoked", "Distrusted"];

/** The site's settings: which chain, which RPC, which contract. Served next to the pages. */
export async function loadConfig() {
  const res = await fetch("config.json", { cache: "no-store" });
  if (!res.ok) throw new Error("config.json missing");
  const c = await res.json();
  if (!Number.isSafeInteger(c.chainId) || !/^0x[0-9a-fA-F]{40}$/.test(c.contract || "") || !c.rpcUrl) throw new Error("config.json is incomplete");
  return { ...c, contract: getAddress(c.contract), rpcUrl: new URL(c.rpcUrl, location.href).href };
}

export function chainOf(cfg) {
  return defineChain({
    id: cfg.chainId,
    name: cfg.networkName || `Chain ${cfg.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
}

/**
 * A read client that refuses to answer from the wrong place: the RPC must be on the configured chain
 * and the contract must exist there. Otherwise the page says "can't check", never "fake".
 */
export async function readClient(cfg) {
  const client = createPublicClient({ chain: chainOf(cfg), pollingInterval: 1000, transport: http(cfg.rpcUrl, { retryCount: 1, timeout: 10000 }) });
  const id = await client.getChainId();
  if (id !== cfg.chainId) throw new Error(`the RPC is on chain ${id}, expected ${cfg.chainId}`);
  const code = await client.getBytecode({ address: cfg.contract });
  if (!code || code === "0x") throw new Error("the Pramaan contract was not found on this network");
  return client;
}

/** Connect the institution's wallet and check it is on the right chain. */
export async function connectWallet(cfg, provider) {
  if (!provider) throw new Error("No wallet found. Install MetaMask (or another wallet) and reload.");
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  if (!accounts?.length) throw new Error("The wallet shared no account.");
  const chainId = Number(await provider.request({ method: "eth_chainId" }));
  const wallet = createWalletClient({ account: getAddress(accounts[0]), chain: chainOf(cfg), transport: custom(provider) });
  return { wallet, account: getAddress(accounts[0]), chainId, rightChain: chainId === cfg.chainId };
}

export async function switchChain(cfg, provider) {
  await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + cfg.chainId.toString(16) }] });
}

/** Which institution (if any) this key belongs to, read from the chain, never from the page. */
export async function institutionOf(client, cfg, account) {
  const id = Number(await client.readContract({ address: cfg.contract, abi: ABI, functionName: "issuerOfKey", args: [account] }));
  if (id === 0) return null;
  const [, keyActiveFrom, active, name] = await client.readContract({ address: cfg.contract, abi: ABI, functionName: "issuers", args: [id] });
  return { id, name, active, keyActiveFrom: Number(keyActiveFrom) };
}

/** Pull the BatchIssued event for our root out of a receipt (never trust a guessed batch number). */
export function batchIdFromReceipt(cfg, receipt, root) {
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== cfg.contract) continue;
    try {
      const ev = decodeEventLog({ abi: ABI, data: log.data, topics: log.topics });
      if (ev.eventName === "BatchIssued" && ev.args.root === root) return Number(ev.args.batchId);
    } catch { /* another event */ }
  }
  throw new Error("BatchIssued event not found in the receipt");
}

/** Short, human error text for wallet and contract errors. */
export function explain(e) {
  const s = `${e?.shortMessage || ""} ${e?.message || ""} ${e?.cause?.data?.errorName || ""}`;
  if (/User (rejected|denied)|4001|rejected the request/i.test(s) || e?.code === 4001 || e?.cause?.code === 4001) return "You rejected the transaction in your wallet. Nothing was published.";
  for (const [k, msg] of [
    ["NotIssuer", "This wallet is not a registered institution key."],
    ["IssuerSuspended", "This institution is suspended by the council."],
    ["KeyNotActiveYet", "This new key becomes active in the next block. Try again in a few seconds."],
    ["AlreadyRevoked", "This certificate is already revoked."],
    ["ZeroValue", "Something is empty (certificate number, reason or batch)."],
  ]) if (s.includes(k)) return msg;
  return (e?.shortMessage || e?.message || String(e)).split("\n")[0];
}
