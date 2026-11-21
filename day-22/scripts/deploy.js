// Deploys the Week 1 contracts (Day 1 TodoList, Day 2 PiggyBank) to a local
// Hardhat node and writes their addresses + ABIs for the web app.
//
//   npx hardhat node            (terminal 1)
//   npm run deploy              (terminal 2)
//
// Output: app/lib/deployments.json — the ONLY place the app learns addresses.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const { chainId } = await hre.ethers.provider.getNetwork();
  // Refuse to run anywhere but a local chain: this script uses Hardhat's
  // public test accounts, which must never touch a real network.
  if (chainId !== 31337n) throw new Error(`Refusing to deploy to chain ${chainId}: local Hardhat (31337) only`);

  const todo = await hre.ethers.deployContract("TodoList");
  const piggy = await hre.ethers.deployContract("PiggyBank");
  await Promise.all([todo.waitForDeployment(), piggy.waitForDeployment()]);

  const abiOf = async (name) => (await hre.artifacts.readArtifact(name)).abi;
  const out = {
    chainId: Number(chainId),
    contracts: {
      TodoList: { address: await todo.getAddress(), abi: await abiOf("TodoList") },
      PiggyBank: { address: await piggy.getAddress(), abi: await abiOf("PiggyBank") },
    },
  };
  const file = path.join(__dirname, "..", "app", "lib", "deployments.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`TodoList  ${out.contracts.TodoList.address}`);
  console.log(`PiggyBank ${out.contracts.PiggyBank.address}`);
  console.log(`Wrote ${path.relative(process.cwd(), file)} (chain ${out.chainId})`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
