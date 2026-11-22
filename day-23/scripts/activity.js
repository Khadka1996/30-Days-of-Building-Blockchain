// Make some activity for the feed: three people use the to-do list and the piggy bank.
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

async function main() {
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployment.json"), "utf8")).contracts;
  const todo = await ethers.getContractAt("TodoList", dep.TodoList.address);
  const bank = await ethers.getContractAt("PiggyBank", dep.PiggyBank.address);
  const [anita, bikash, chandra] = await ethers.getSigners();
  const now = (await ethers.provider.getBlock("latest")).timestamp;

  await (await todo.connect(anita).addTask("Pay electricity bill")).wait();
  await (await todo.connect(bikash).addTask("Buy momo for the team")).wait();
  await (await bank.connect(anita).deposit(now + 30 * 86400, { value: ethers.parseEther("1.5") })).wait();
  await (await todo.connect(anita).completeTask(1)).wait();
  await (await bank.connect(chandra).deposit(now + 7 * 86400, { value: ethers.parseEther("0.25") })).wait();
  await (await bank.connect(anita).deposit(0, { value: ethers.parseEther("0.5") })).wait();
  await (await todo.connect(chandra).addTask("Read about chain reorgs")).wait();
  await (await todo.connect(bikash).deleteTask(1)).wait();
  console.log("8 transactions sent");
}

main().catch((e) => { console.error(e); process.exit(1); });
