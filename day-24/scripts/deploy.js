// Deploy the Day 1 TodoList and a SmartWallet (owned by account #1) to the
// LOCAL node, add two tasks for account #0, and write deployments.json for
// the server (`npm run app`).
const fs = require("fs");
const path = require("path");
const { ethers, artifacts } = require("hardhat");

async function main() {
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== 31337n) throw new Error(`Refusing to deploy to chain ${chainId}: local Hardhat only`);
  const [me, walletOwner] = await ethers.getSigners();

  const todo = await ethers.deployContract("TodoList");
  await todo.waitForDeployment();
  await (await todo.addTask("Buy momo for the team")).wait();
  await (await todo.addTask("Review the Day 24 login code")).wait();
  const wallet = await ethers.deployContract("SmartWallet", [walletOwner.address]);
  await wallet.waitForDeployment();

  const out = {
    chainId: 31337,
    TodoList: await todo.getAddress(),
    SmartWallet: await wallet.getAddress(),
    todoAbi: (await artifacts.readArtifact("TodoList")).abi,
  };
  fs.writeFileSync(path.join(__dirname, "..", "deployments.json"), JSON.stringify(out, null, 2));
  console.log(`TodoList     ${out.TodoList}  (2 tasks for ${me.address})`);
  console.log(`SmartWallet  ${out.SmartWallet}  (owner ${walletOwner.address})`);
  console.log("Saved deployments.json → now run: npm run app");
}

main().catch((e) => { console.error(e); process.exit(1); });
