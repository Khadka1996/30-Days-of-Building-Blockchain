// A full rehearsal of the Sepolia deployment on the local Hardhat chain.
//   npm run demo
const hre = require("hardhat");
const os = require("os");
const fs = require("fs");
const path = require("path");
const kit = require("../lib/deployKit");

async function main() {
  const { ethers } = hre;
  const [deployer, a, b, c] = await ethers.getSigners();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "day07-"));
  const owners = [a.address, b.address, c.address];
  const show = (label, value) => console.log(label.padEnd(44) + value);
  const refused = async (label, fn) => {
    try { await fn(); show(label, "NOT refused (bug!)"); } catch (e) { show(label, "refused: " + e.message.split(". ")[0]); }
  };

  console.log("1) Safety checks before any gas is spent");
  await refused("Deploy to Ethereum mainnet (chain 1):", async () => kit.assertSafeNetwork(1));
  await refused("Owner listed twice:", () => kit.deployAll(hre, { owners: [a.address, a.address], threshold: 1, outDir, log: () => {} }));
  await refused("Threshold 4 with 3 owners:", () => kit.deployAll(hre, { owners, threshold: 4, outDir, log: () => {} }));
  const poor = ethers.Wallet.createRandom().connect(ethers.provider);
  await deployer.sendTransaction({ to: poor.address, value: ethers.parseEther("0.0001") });
  await refused("Wallet with 0.0001 ETH:", () => kit.deployAll(hre, { owners, threshold: 2, outDir, signer: poor, log: () => {} }));
  show("Transactions sent by that wallet:", String(await ethers.provider.getTransactionCount(poor.address)));

  console.log("\n2) Deploy all six Week 1 contracts");
  const { record } = await kit.deployAll(hre, { owners, threshold: 2, outDir });
  const total = Object.values(record.contracts).reduce((s, x) => s + BigInt(x.gasUsed), 0n);
  show("Total gas for six contracts:", total.toString());
  show("At 2 gwei on Sepolia that costs about:", ethers.formatEther(total * 2_000_000_000n) + " ETH");

  console.log("\n3) Run it again (as after a failed run): nothing is paid twice");
  const before = await ethers.provider.getTransactionCount(deployer.address);
  await kit.deployAll(hre, { owners, threshold: 2, outDir });
  show("New transactions on the second run:", String((await ethers.provider.getTransactionCount(deployer.address)) - before));
  await refused("Resume with different multisig owners:", () => kit.deployAll(hre, { owners: [a.address, b.address], threshold: 2, outDir, log: () => {} }));

  console.log("\n4) Post-deploy check");
  const problems = await kit.checkDeployment(hre, record);
  show("Problems found:", problems.length ? problems.join("; ") : "none");

  console.log("\n5) Etherscan verification commands this record produces");
  for (const cmd of kit.verifyCommands({ ...record, network: "sepolia" }, () => "deployments/sepolia.MultiSigWallet.args.js")) console.log("  " + cmd);
  fs.rmSync(outDir, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
