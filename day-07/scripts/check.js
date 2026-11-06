// After deploying: is every contract really on-chain with the settings we asked for?
//   npx hardhat run scripts/check.js --network sepolia
const hre = require("hardhat");
const path = require("path");
const kit = require("../lib/deployKit");

async function main() {
  const { chainId } = await hre.ethers.provider.getNetwork();
  const name = Number(chainId) === 31337 ? "hardhat" : "sepolia";
  const record = kit.loadRecord(kit.recordPath(path.join(__dirname, "..", "deployments"), name));
  if (!record) throw new kit.DeployError(`deployments/${name}.json not found: deploy first.`);
  const problems = await kit.checkDeployment(hre, record);
  if (problems.length) { problems.forEach((p) => console.log("  ✗ " + p)); process.exitCode = 1; return; }
  for (const c of kit.CONTRACTS) console.log(`  ✓ Day ${c.day} ${c.name.padEnd(15)} ${record.contracts[c.name].address}`);
  console.log("All six contracts are deployed and the multisig settings match.");
}

main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
