// Verify every contract in deployments/sepolia.json on Etherscan.
//   npx hardhat run scripts/verify.js --network sepolia
const hre = require("hardhat");
const path = require("path");
const kit = require("../lib/deployKit");

async function main() {
  if (!process.env.ETHERSCAN_API_KEY) throw new kit.DeployError("Set ETHERSCAN_API_KEY in .env first.");
  const { chainId } = await hre.ethers.provider.getNetwork();
  kit.assertSafeNetwork(chainId);
  if (Number(chainId) === 31337) throw new kit.DeployError("Etherscan cannot see the local chain: use --network sepolia.");

  const record = kit.loadRecord(kit.recordPath(path.join(__dirname, "..", "deployments"), "sepolia"));
  if (!record) throw new kit.DeployError("deployments/sepolia.json not found: deploy first.");

  for (const job of kit.verifyJobs(record)) {
    process.stdout.write(`${job.name.padEnd(15)} ${job.address} ... `);
    try {
      await hre.run("verify:verify", { address: job.address, constructorArguments: job.constructorArguments, contract: job.contract });
      console.log("verified");
    } catch (e) {
      // Running verify twice is fine: an already-verified contract is not an error.
      if (/already verified/i.test(e.message)) console.log("already verified");
      else { console.log("FAILED"); console.error("  " + e.message.split("\n")[0]); process.exitCode = 1; }
    }
  }
}

main().catch((e) => {
  console.error(e instanceof kit.DeployError ? `Stopped: ${e.message}` : e);
  process.exitCode = 1;
});
