// Start the relayer against a running node (default: the local Hardhat node).
//   RPC_URL               default http://127.0.0.1:8545
//   RELAYER_PRIVATE_KEY   the relayer's own key (a hot wallet with a little ETH).
//                         If unset, uses the node's unlocked dev account #9 (local only!).
//   PORT                  default 4025
const fs = require("node:fs");
const path = require("node:path");
const { createPublicClient, createWalletClient, http } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const { createRelayer } = require("./server");

async function main() {
  const rpc = process.env.RPC_URL || "http://127.0.0.1:8545";
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments.json"), "utf8"));
  const art = (name, dir = name) => require(path.join(__dirname, "..", "artifacts", "contracts", `${dir}.sol`, `${name}.json`)).abi;
  const publicClient = createPublicClient({ transport: http(rpc) });
  let account;
  if (process.env.RELAYER_PRIVATE_KEY) account = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY);
  else account = (await publicClient.request({ method: "eth_accounts" }))[9];
  const walletClient = createWalletClient({ transport: http(rpc), account });
  const relayer = typeof account === "string" ? account : account.address;
  const app = createRelayer({
    publicClient, walletClient, relayer, chainId: dep.chainId,
    forwarder: { address: dep.forwarder, abi: art("Forwarder") },
    todo: { address: dep.todo, abi: art("GaslessTodoList") },
  });
  const port = await app.listen(Number(process.env.PORT || 4025));
  console.log(`Gasless to-do: http://127.0.0.1:${port}   relayer ${relayer} pays the gas (chain ${rpc})`);
}
main().catch((e) => { console.error(e); process.exit(1); });
