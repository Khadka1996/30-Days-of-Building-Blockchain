import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { rpc } from "./rpc.js";

// Make sure the Week 1 contracts are deployed at the addresses the app was built with.
export default async function globalSetup() {
  const dep = JSON.parse(readFileSync(new URL("../lib/deployments.json", import.meta.url)));
  for (let i = 0; ; i++) {
    try { await rpc("eth_chainId"); break; } catch { if (i > 60) throw new Error("Hardhat node not reachable"); await new Promise((r) => setTimeout(r, 1000)); }
  }
  const code = await rpc("eth_getCode", [dep.contracts.TodoList.address, "latest"]);
  if (code !== "0x") return; // already deployed (node reused)
  execSync("npx hardhat run scripts/deploy.js --network localhost", { cwd: new URL("../..", import.meta.url).pathname, stdio: "inherit" });
  const after = JSON.parse(readFileSync(new URL("../lib/deployments.json", import.meta.url)));
  if (after.contracts.TodoList.address !== dep.contracts.TodoList.address) {
    throw new Error("Contracts deployed to new addresses: restart the node (fresh chain) or rebuild the app");
  }
}
