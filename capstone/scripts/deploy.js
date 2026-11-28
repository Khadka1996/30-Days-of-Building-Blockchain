// Deploy Pramaan and write the web app's config.
//   npx hardhat run scripts/deploy.js --network sepolia      (see DEPLOY.md)
//   npx hardhat run scripts/deploy.js --network localhost    (against `npx hardhat node`)
// Writes deployments/<network>.json and app/public/config.json. Never asks for or prints a private key.
const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");

async function main() {
  const { ethers, network } = hre;
  const [deployer] = await ethers.getSigners();
  const local = network.config.chainId === 31337;
  const council = process.env.COUNCIL_ADDRESS || (local ? deployer.address : "");
  if (!ethers.isAddress(council)) throw new Error("Set COUNCIL_ADDRESS (the council multisig) in .env");
  if (!local && (await ethers.provider.getCode(council)) === "0x") {
    console.warn(`⚠ COUNCIL_ADDRESS ${council} is a plain wallet, not a multisig. Fine for a test demo; use a 2-of-3 Safe in production.`);
  }
  const { chainId } = await ethers.provider.getNetwork();
  console.log(`Deploying Pramaan to ${network.name} (chain ${chainId}) from ${deployer.address}`);
  const p = await (await ethers.getContractFactory("Pramaan")).deploy(council);
  const tx = p.deploymentTransaction();
  const receipt = await tx.wait(local ? 1 : 3); // wait a few blocks so Etherscan can see the code
  const address = await p.getAddress();
  console.log(`Pramaan ${address} · tx ${tx.hash} · gas ${receipt.gasUsed} · block ${receipt.blockNumber}`);

  const out = { network: network.name, chainId: Number(chainId), contract: address, council, deployTx: tx.hash, block: receipt.blockNumber };
  fs.mkdirSync(path.join(__dirname, "../deployments"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, `../deployments/${network.name}.json`), JSON.stringify(out, null, 2) + "\n");

  const config = {
    chainId: Number(chainId),
    networkName: local ? "Hardhat (local)" : network.name === "sepolia" ? "Sepolia test network" : network.name,
    rpcUrl: process.env.APP_RPC_URL || (local ? "http://127.0.0.1:8545" : ""),
    contract: address,
    ...(process.env.SITE_URL ? { siteUrl: process.env.SITE_URL } : {}),
  };
  if (!config.rpcUrl) throw new Error("Set APP_RPC_URL (a public read-only RPC for verifiers) in .env");
  fs.writeFileSync(path.join(__dirname, "../app/public/config.json"), JSON.stringify(config, null, 2) + "\n");
  console.log("Wrote deployments/%s.json and app/public/config.json", network.name);
  if (!local) console.log(`Verify: npx hardhat verify --network ${network.name} ${address} ${council}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
