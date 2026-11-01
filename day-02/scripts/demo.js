// Quick demo on the local Hardhat network: save ETH with a 30-day lock, try to
// take it out early, jump forward in time, then withdraw. Prints gas per action.
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 24 * 60 * 60;

async function main() {
  const [alice] = await ethers.getSigners();
  const piggy = await ethers.deployContract("PiggyBank");
  await piggy.waitForDeployment();
  console.log("PiggyBank deployed at", await piggy.getAddress());

  const gas = async (label, txPromise) => {
    const receipt = await (await txPromise).wait();
    console.log(`${label.padEnd(34)} gas used: ${receipt.gasUsed}`);
  };

  const unlockAt = (await time.latest()) + 30 * DAY;
  await gas("deposit 1 ETH, lock 30 days", piggy.deposit(unlockAt, { value: ethers.parseEther("1") }));
  await gas("deposit 0.5 ETH more", piggy.deposit(0, { value: ethers.parseEther("0.5") }));
  await gas("extendLock +7 days", piggy.extendLock(unlockAt + 7 * DAY));

  const left = await piggy.timeLeft(alice.address);
  console.log(`Time left: ${(Number(left) / DAY).toFixed(1)} days`);

  try {
    await piggy.withdraw.staticCall();
  } catch (err) {
    const decoded = err.data ? piggy.interface.parseError(err.data) : null;
    console.log("withdraw() today:", decoded ? `reverted with ${decoded.name}` : "reverted");
  }

  await time.increaseTo(unlockAt + 7 * DAY);
  console.log("...37 days later...");
  const before = await ethers.provider.getBalance(alice.address);
  await gas("withdraw()", piggy.withdraw());
  const after = await ethers.provider.getBalance(alice.address);
  console.log(`Alice got back ${Number(ethers.formatEther(after - before)).toFixed(4)} ETH (1.5 ETH minus a tiny gas fee)`);
  console.log("Total still locked:", ethers.formatEther(await piggy.totalLocked()), "ETH");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
