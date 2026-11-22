// Deploy the Day 1 TodoList and Day 2 PiggyBank to the LOCAL node and write
// deployment.json (addresses + the block each was deployed in: the indexer
// starts there instead of scanning from block 0).
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function main() {
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== 31337n) throw new Error(`Refusing to deploy to chain ${chainId}: local Hardhat only`);

  const contracts = {};
  for (const name of ["TodoList", "PiggyBank"]) {
    const c = await ethers.deployContract(name);
    const receipt = await c.deploymentTransaction().wait();
    contracts[name] = { address: await c.getAddress(), block: receipt.blockNumber };
    console.log(`${name.padEnd(9)} ${contracts[name].address} (block ${receipt.blockNumber})`);
  }
  const file = path.join(__dirname, "..", "deployment.json");
  fs.writeFileSync(file, JSON.stringify({ network: network.name, chainId: 31337, contracts }, null, 2));
  // A new deployment means a new index.
  fs.rmSync(path.join(__dirname, "..", "data"), { recursive: true, force: true });
  console.log("Saved deployment.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
