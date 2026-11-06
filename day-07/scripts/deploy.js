// Deploy all six Week 1 contracts.
//   Local:   npx hardhat run scripts/deploy.js
//   Sepolia: npx hardhat run scripts/deploy.js --network sepolia   (see DEPLOY.md)
const hre = require("hardhat");
const path = require("path");
const fs = require("fs");
const kit = require("../lib/deployKit");

async function main() {
  const { ethers } = hre;
  const { chainId } = await ethers.provider.getNetwork();
  kit.assertSafeNetwork(chainId);
  const local = Number(chainId) === 31337;

  // Multisig settings come from .env. Locally we fall back to three test accounts;
  // on Sepolia they MUST be set on purpose (no silent "deployer owns everything").
  let owners = kit.parseOwners(process.env.MULTISIG_OWNERS, ethers);
  let threshold = process.env.MULTISIG_THRESHOLD;
  if (owners.length === 0 && local) {
    owners = (await ethers.getSigners()).slice(0, 3).map((s) => s.address);
    threshold = threshold || 2;
  }
  if (owners.length === 0) throw new kit.DeployError("Set MULTISIG_OWNERS and MULTISIG_THRESHOLD in .env before deploying to Sepolia.");

  const outDir = path.join(__dirname, "..", "deployments");
  const { record, file } = await kit.deployAll(hre, { owners, threshold, outDir });

  // The multisig takes an array argument, which the verify CLI reads from a file.
  const argsFile = path.join(outDir, `${record.network}.MultiSigWallet.args.js`);
  fs.writeFileSync(argsFile, `module.exports = ${JSON.stringify(record.contracts.MultiSigWallet.args, null, 2)};\n`);

  console.log(`\nSaved: ${path.relative(process.cwd(), file)}`);
  if (!local) {
    console.log("\nVerify on Etherscan (or run: npm run verify:sepolia):");
    for (const c of kit.verifyCommands(record, () => path.relative(process.cwd(), argsFile))) console.log("  " + c);
  }
}

main().catch((e) => {
  console.error(e instanceof kit.DeployError ? `\nStopped: ${e.message}` : e);
  process.exitCode = 1;
});
