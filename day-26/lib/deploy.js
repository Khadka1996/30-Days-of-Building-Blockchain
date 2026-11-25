// Day 26 — deploy the Messenger and the to-do app on both chains and connect them.
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");
const { devWallet } = require("./chains");

const ART = path.join(__dirname, "..", "artifacts", "contracts");

function artifact(name) {
  const file = name.startsWith("test/") ? `test/${name.slice(5)}.sol/${name.slice(5)}.json` : `${name}.sol/${name}.json`;
  const p = path.join(ART, file);
  if (!fs.existsSync(p)) throw new Error(`missing ${p} — run "npx hardhat compile" first`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function deployContract(wallet, name, args = []) {
  const a = artifact(name);
  const c = await new ethers.ContractFactory(a.abi, a.bytecode, wallet).deploy(...args);
  await c.waitForDeployment();
  return c;
}

/**
 * Three validators (random keys: they only sign, they never need ETH) with a
 * 2-of-3 threshold. In a real bridge these are independent companies.
 */
function newValidators(n = 3) {
  return Array.from({ length: n }, () => ethers.Wallet.createRandom());
}

/**
 * Deploy on both chains.
 * @returns {{ l1: Side, l2: Side, validators: ethers.Wallet[] }}
 *   Side = { chain, owner, messenger, todo, address: { messenger, todo } }
 */
async function deployBoth(chains, { validators = newValidators(), threshold = 2 } = {}) {
  const sides = {};
  for (const key of ["l1", "l2"]) {
    const chain = chains[key];
    const owner = devWallet(0, chain.provider);
    const messenger = await deployContract(owner, "Messenger", [validators.map((v) => v.address), threshold, owner.address]);
    sides[key] = { chain, owner, messenger };
  }
  for (const [me, other] of [["l1", "l2"], ["l2", "l1"]]) {
    const s = sides[me];
    s.todo = await deployContract(s.owner, "CrossChainTodo", [await s.messenger.getAddress(), sides[other].chain.chainId]);
    await (await s.messenger.setRemote(sides[other].chain.chainId, await sides[other].messenger.getAddress())).wait();
  }
  for (const s of Object.values(sides)) s.address = { messenger: await s.messenger.getAddress(), todo: await s.todo.getAddress() };
  return { ...sides, validators, threshold };
}

module.exports = { artifact, deployContract, deployBoth, newValidators };
