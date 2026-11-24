// Deploy the Forwarder and the gasless to-do list to the local node, and save
// their addresses for the relayer. Run: npm run chain, then npm run deploy.
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("hardhat");

async function main() {
  const forwarder = await ethers.deployContract("Forwarder");
  await forwarder.waitForDeployment();
  const todo = await ethers.deployContract("GaslessTodoList", [await forwarder.getAddress()]);
  await todo.waitForDeployment();
  const out = { chainId: Number((await ethers.provider.getNetwork()).chainId), forwarder: await forwarder.getAddress(), todo: await todo.getAddress() };
  fs.writeFileSync(path.join(__dirname, "..", "deployments.json"), JSON.stringify(out, null, 2));
  console.log("Forwarder       ", out.forwarder);
  console.log("GaslessTodoList ", out.todo);
  console.log("Saved deployments.json. Next: npm run relayer");
}
main().catch((e) => { console.error(e); process.exit(1); });
