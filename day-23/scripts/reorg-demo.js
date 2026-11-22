// Fake a chain reorganisation on the local node so you can watch the feed fix itself.
//
// 1. snapshot the chain   2. add a task + lock ETH (2 blocks the feed will show)
// 3. wait for the indexer  4. revert to the snapshot (those 2 blocks vanish)
// 5. mine 3 different blocks in their place — a longer, competing chain
//
// On a real network this happens when two validators build on the same parent
// and the network later agrees on the other branch.
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployment.json"), "utf8")).contracts;
  const todo = await ethers.getContractAt("TodoList", dep.TodoList.address);
  const bank = await ethers.getContractAt("PiggyBank", dep.PiggyBank.address);
  const [, bikash, , dipa] = await ethers.getSigners();

  const snap = await network.provider.send("evm_snapshot");
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  await (await todo.connect(dipa).addTask("This task will vanish in a reorg")).wait();
  await (await bank.connect(dipa).deposit(now + 86400, { value: ethers.parseEther("2") })).wait();
  console.log("Old branch: 2 blocks with events. Waiting 3 s for the feed…");
  await sleep(3000);

  await network.provider.send("evm_revert", [snap]);
  await network.provider.send("evm_increaseTime", [15]); // new blocks get new timestamps → new hashes
  await (await todo.connect(bikash).addTask("Written on the winning branch")).wait();
  await network.provider.send("hardhat_mine", ["0x2"]);
  console.log("Reorg done: the 2 old blocks were replaced by 3 new ones.");
}

main().catch((e) => { console.error(e); process.exit(1); });
