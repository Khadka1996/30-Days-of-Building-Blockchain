// Quick demo on the local Hardhat network: add, complete and delete tasks,
// printing the gas each action costs.
const { ethers } = require("hardhat");

async function main() {
  const [alice] = await ethers.getSigners();
  const todo = await ethers.deployContract("TodoList");
  await todo.waitForDeployment();
  console.log("TodoList deployed at", await todo.getAddress());

  const gas = async (label, txPromise) => {
    const receipt = await (await txPromise).wait();
    console.log(`${label.padEnd(28)} gas used: ${receipt.gasUsed}`);
  };

  await gas('addTask("Buy milk")', todo.addTask("Buy milk"));
  await gas('addTask("Learn Solidity")', todo.addTask("Learn Solidity"));
  await gas("completeTask(1)", todo.completeTask(1));
  await gas("deleteTask(1)", todo.deleteTask(1));

  const tasks = await todo.getTasks(alice.address);
  console.log("Alice's list now:", tasks.map((t) => `#${t.id} ${t.text} (${t.completed ? "done" : "open"})`));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
