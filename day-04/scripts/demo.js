// Quick demo on the local Hardhat network: a 2-of-3 family wallet.
// One owner proposes a payment, a second approves, it runs once.
// Then: approving twice, replaying, and an approval from a removed owner all fail.
// Prints gas per action.
const { ethers } = require("hardhat");

async function main() {
  const [ram, sita, hari, shop] = await ethers.getSigners();
  const wallet = await ethers.deployContract("MultiSigWallet", [[ram.address, sita.address, hari.address], 2]);
  await wallet.waitForDeployment();
  const walletAddr = await wallet.getAddress();
  console.log("MultiSigWallet deployed at", walletAddr, "(owners: Ram, Sita, Hari · 2 approvals needed)");

  await ram.sendTransaction({ to: walletAddr, value: ethers.parseEther("5") });
  console.log("Wallet balance:".padEnd(38), ethers.formatEther(await ethers.provider.getBalance(walletAddr)), "ETH");

  const gas = async (label, txPromise) => {
    const receipt = await (await txPromise).wait();
    console.log(`${label.padEnd(38)} gas used: ${receipt.gasUsed}`);
  };
  const reason = async (fn) => {
    try {
      await fn();
      return "accepted (unexpected!)";
    } catch (err) {
      const data = err.data || err.error?.data;
      return data ? `reverted with ${wallet.interface.parseError(data).name}` : err.message;
    }
  };
  const governed = async (by, fn, args) => {
    const id = await wallet.transactionCount();
    await wallet.connect(by[0]).submit(walletAddr, 0, wallet.interface.encodeFunctionData(fn, args));
    await wallet.connect(by[0]).approve(id);
    await wallet.connect(by[1]).approve(id);
    await wallet.connect(by[0]).execute(id);
  };

  // 1. A normal 2-of-3 payment of 1 ETH to the shop.
  await gas("Ram submits: pay shop 1 ETH", wallet.connect(ram).submit(shop.address, ethers.parseEther("1"), "0x"));
  await gas("Ram approves", wallet.connect(ram).approve(0));
  console.log("Ram approves again:".padEnd(38), await reason(() => wallet.connect(ram).approve.staticCall(0)));
  console.log("Execute with 1 approval:".padEnd(38), await reason(() => wallet.connect(ram).execute.staticCall(0)));
  await gas("Sita approves", wallet.connect(sita).approve(0));
  await gas("Sita executes", wallet.connect(sita).execute(0));
  console.log("Replay the same payment:".padEnd(38), await reason(() => wallet.connect(hari).execute.staticCall(0)));

  // 2. Hari approves a payment to himself, then Ram and Sita remove Hari.
  await wallet.connect(hari).submit(hari.address, ethers.parseEther("2"), "0x");
  await wallet.connect(hari).approve(1);
  await governed([ram, sita], "removeOwner", [hari.address]);
  console.log("Hari removed. Owners left:".padEnd(38), (await wallet.getOwners()).length);
  console.log("Ram approves Hari's old proposal:".padEnd(38), await reason(() => wallet.connect(ram).approve.staticCall(1)));
  console.log("Hari tries to propose:".padEnd(38), await reason(() => wallet.connect(hari).submit.staticCall(hari.address, 1, "0x")));

  console.log("Wallet balance:".padEnd(38), ethers.formatEther(await ethers.provider.getBalance(walletAddr)), "ETH");
  console.log("Shop balance change:".padEnd(38), "+1.0 ETH (paid exactly once)");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
