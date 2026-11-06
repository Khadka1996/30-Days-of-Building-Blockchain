// Day 07 — the deploy kit.
//
// Everything the deploy, verify and check scripts need lives here as small,
// testable functions. The scripts in scripts/ are thin wrappers around them.
//
// Safety rules this file enforces (see QA.md):
//   - only the local Hardhat chain (31337) and Sepolia (11155111) are allowed;
//   - multisig owners and threshold are checked BEFORE any gas is spent;
//   - the deployer must hold enough ETH for the whole run BEFORE the first tx;
//   - every finished deploy is written to disk at once, so a failed run can be
//     resumed without paying for the same contract twice;
//   - a resume never reuses a contract that was deployed with other settings.

const fs = require("fs");
const path = require("path");

const CHAINS = {
  31337: "hardhat (local)",
  11155111: "sepolia (test network)",
};

// The six Week 1 contracts, in deploy order. `args(config)` returns the
// constructor arguments; only the multisig takes any.
const CONTRACTS = [
  { name: "TodoList", day: "01", args: () => [] },
  { name: "PiggyBank", day: "02", args: () => [] },
  { name: "Voting", day: "03", args: () => [] },
  { name: "MultiSigWallet", day: "04", args: (c) => [c.owners, c.threshold] },
  { name: "Escrow", day: "05", args: () => [] },
  { name: "CrowdFund", day: "06", args: () => [] },
];

const MAX_OWNERS = 10; // same limit as MultiSigWallet.MAX_OWNERS

class DeployError extends Error {}

// ---------------------------------------------------------------- checks

/** Refuse every chain except local Hardhat and Sepolia (no mainnet by accident). */
function assertSafeNetwork(chainId) {
  const id = Number(chainId);
  if (!CHAINS[id]) {
    throw new DeployError(
      `Refusing to deploy to chain ${id}. This kit only deploys to Sepolia (11155111) or the local Hardhat chain (31337).`
    );
  }
  return CHAINS[id];
}

/** A private key must be 0x + 64 hex characters. The key itself is never printed. */
function assertPrivateKeyFormat(key) {
  if (typeof key !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new DeployError("PRIVATE_KEY must be 0x followed by 64 hex characters (the key is not shown here).");
  }
  if (/^0x0{64}$/.test(key)) throw new DeployError("PRIVATE_KEY is all zeros: use a real test-only key.");
}

/**
 * Parse "0xA,0xB,0xC" into a clean owner list and check it the same way the
 * MultiSigWallet constructor does, so a bad setting fails for free instead of
 * failing on-chain after paying gas.
 */
function parseOwners(raw, ethers) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || raw.trim() === "") return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean).map((a) => {
    if (!ethers.isAddress(a)) throw new DeployError(`MULTISIG_OWNERS: "${a}" is not a valid address.`);
    return ethers.getAddress(a);
  });
}

function validateMultisig(owners, threshold, ethers) {
  if (!Array.isArray(owners) || owners.length === 0 || owners.length > MAX_OWNERS) {
    throw new DeployError(`MultiSigWallet needs 1 to ${MAX_OWNERS} owners, got ${owners ? owners.length : 0}.`);
  }
  const seen = new Set();
  for (const o of owners) {
    if (!ethers.isAddress(o)) throw new DeployError(`Owner "${o}" is not a valid address.`);
    const a = ethers.getAddress(o);
    if (a === ethers.ZeroAddress) throw new DeployError("An owner cannot be the zero address.");
    if (seen.has(a)) throw new DeployError(`Owner ${a} is listed twice.`);
    seen.add(a);
  }
  const t = Number(threshold);
  if (!Number.isInteger(t) || t < 1 || t > owners.length) {
    throw new DeployError(`Threshold must be a whole number from 1 to ${owners.length}, got ${threshold}.`);
  }
  return { owners: owners.map((o) => ethers.getAddress(o)), threshold: t };
}

// ---------------------------------------------------------- record file

function recordPath(outDir, networkName) {
  return path.join(outDir, `${networkName}.json`);
}

function loadRecord(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function saveRecord(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write to a temp file and rename, so a crash never leaves half a JSON file.
  fs.writeFileSync(file + ".tmp", JSON.stringify(record, null, 2) + "\n");
  fs.renameSync(file + ".tmp", file);
}

const sameArgs = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --------------------------------------------------------------- deploy

/**
 * Deploy all six Week 1 contracts (or resume a run that stopped half-way).
 * @param hre     the Hardhat runtime
 * @param options { owners, threshold, outDir, confirmations, signer, log }
 * @returns the deployment record that was written to disk
 */
async function deployAll(hre, options) {
  const { ethers } = hre;
  const log = options.log || console.log;
  const signer = options.signer || (await ethers.getSigners())[0];
  const provider = signer.provider;

  // 1. Where are we? Refuse anything but Sepolia / local.
  const { chainId } = await provider.getNetwork();
  const chainLabel = assertSafeNetwork(chainId);
  const networkName = Number(chainId) === 31337 ? "hardhat" : "sepolia";

  // 2. Check settings before spending anything.
  const config = validateMultisig(options.owners, options.threshold, ethers);
  const confirmations = options.confirmations ?? (Number(chainId) === 31337 ? 1 : 5);

  // 3. Resume: reuse contracts from an earlier run only if they are really
  //    there AND were deployed with the same constructor arguments.
  const file = recordPath(options.outDir, networkName);
  const old = loadRecord(file);
  const record = {
    network: networkName,
    chainId: Number(chainId),
    deployer: await signer.getAddress(),
    startedAt: old && old.chainId === Number(chainId) ? old.startedAt : new Date().toISOString(),
    contracts: {},
  };
  const todo = [];
  for (const c of CONTRACTS) {
    const args = c.args(config);
    const prev = old && old.chainId === Number(chainId) ? old.contracts[c.name] : null;
    if (prev) {
      const code = await provider.getCode(prev.address);
      if (code !== "0x") {
        if (!sameArgs(prev.args, args)) {
          throw new DeployError(
            `${c.name} at ${prev.address} was deployed with different settings. ` +
              `Move ${file} away (or restore the old settings) before deploying again.`
          );
        }
        record.contracts[c.name] = prev;
        log(`  ${c.name.padEnd(15)} already deployed at ${prev.address} (skipped)`);
        continue;
      }
    }
    todo.push({ ...c, args });
  }

  // 4. Gas budget: estimate every remaining deploy and stop if the wallet
  //    cannot pay for all of them (half a deployment helps nobody).
  const fee = await provider.getFeeData();
  const gasPrice = fee.maxFeePerGas ?? fee.gasPrice;
  let gasNeeded = 0n;
  const factories = {};
  for (const c of todo) {
    const factory = await ethers.getContractFactory(c.name, signer);
    factories[c.name] = factory;
    const tx = await factory.getDeployTransaction(...c.args);
    gasNeeded += await provider.estimateGas({ ...tx, from: record.deployer });
  }
  const cost = gasNeeded * gasPrice;
  const balance = await provider.getBalance(record.deployer);
  log(`Network: ${chainLabel} · deployer ${record.deployer}`);
  log(`Balance: ${ethers.formatEther(balance)} ETH · ${todo.length} to deploy · estimated ${gasNeeded} gas ≈ ${ethers.formatEther(cost)} ETH`);
  if (balance < cost) {
    throw new DeployError(
      `Not enough ETH: need about ${ethers.formatEther(cost)} ETH, the deployer has ${ethers.formatEther(balance)} ETH. Nothing was sent.`
    );
  }

  // 5. Deploy, saving the record after EACH contract.
  saveRecord(file, record);
  for (const c of todo) {
    const contract = await factories[c.name].deploy(...c.args);
    const tx = contract.deploymentTransaction();
    const receipt = await tx.wait(confirmations);
    record.contracts[c.name] = {
      day: c.day,
      address: await contract.getAddress(),
      txHash: tx.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      args: c.args,
    };
    saveRecord(file, record);
    log(`  ${c.name.padEnd(15)} ${record.contracts[c.name].address}  gas used: ${receipt.gasUsed}`);
  }
  record.finishedAt = new Date().toISOString();
  saveRecord(file, record);
  return { record, file };
}

// --------------------------------------------------------------- verify

/** One Etherscan verification job per contract, with the exact saved args. */
function verifyJobs(record) {
  return CONTRACTS.filter((c) => record.contracts[c.name]).map((c) => ({
    name: c.name,
    address: record.contracts[c.name].address,
    constructorArguments: record.contracts[c.name].args,
    contract: `contracts/${c.name}.sol:${c.name}`,
  }));
}

/** The same jobs as copy-paste CLI commands (for DEPLOY.md / the terminal). */
function verifyCommands(record, argsFileFor) {
  return verifyJobs(record).map((j) =>
    j.constructorArguments.length === 0
      ? `npx hardhat verify --network ${record.network} ${j.address}`
      : `npx hardhat verify --network ${record.network} --constructor-args ${argsFileFor(j.name)} ${j.address}`
  );
}

// ---------------------------------------------------------------- check

/**
 * After a deploy: is every contract really there, and does the multisig have
 * the owners and threshold we asked for? Returns a list of problems.
 */
async function checkDeployment(hre, record) {
  const { ethers } = hre;
  const problems = [];
  const { chainId } = await ethers.provider.getNetwork();
  if (Number(chainId) !== record.chainId) problems.push(`record is for chain ${record.chainId}, connected to ${chainId}`);
  for (const c of CONTRACTS) {
    const entry = record.contracts[c.name];
    if (!entry) { problems.push(`${c.name}: missing from the record`); continue; }
    if ((await ethers.provider.getCode(entry.address)) === "0x") problems.push(`${c.name}: no code at ${entry.address}`);
  }
  const ms = record.contracts.MultiSigWallet;
  if (ms && problems.length === 0) {
    const wallet = await ethers.getContractAt("MultiSigWallet", ms.address);
    const owners = (await wallet.getOwners()).map((a) => ethers.getAddress(a));
    const threshold = Number(await wallet.threshold());
    if (!sameArgs(owners, ms.args[0])) problems.push("MultiSigWallet: owners on-chain differ from the record");
    if (threshold !== ms.args[1]) problems.push(`MultiSigWallet: threshold on-chain is ${threshold}, record says ${ms.args[1]}`);
  }
  return problems;
}

module.exports = {
  CHAINS, CONTRACTS, MAX_OWNERS, DeployError,
  assertSafeNetwork, assertPrivateKeyFormat, parseOwners, validateMultisig,
  recordPath, loadRecord, saveRecord, deployAll, verifyJobs, verifyCommands, checkDeployment,
};
