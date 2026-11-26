// Shared setup (tests, demo and app): deploy the vault on the in-process Hardhat chain and give the
// monitor viem clients (read + guardian wallet) that talk to that same chain.
const { ethers, network, artifacts } = require("hardhat");
const { createPublicClient, createWalletClient, custom } = require("viem");
const { mnemonicToAccount } = require("viem/accounts");
const { hardhat } = require("viem/chains");
const { createMonitor } = require("../monitor/monitor");

const MNEMONIC = "test test test test test test test test test test test junk"; // Hardhat's public dev mnemonic
const ETH = (n) => ethers.parseEther(String(n));

/** A viem transport over Hardhat's provider. `hooks.after(method, params, result)` may change the result (a lying RPC). */
function transport(hooks = {}) {
  return custom({
    async request({ method, params }) {
      if (hooks.before) await hooks.before(method, params);
      const result = await network.provider.request({ method, params });
      return hooks.after ? hooks.after(method, params, result) : result;
    },
  }, { retryCount: 0 });
}
const viemClient = (hooks) => createPublicClient({ chain: hardhat, transport: transport(hooks), cacheTime: 0, pollingInterval: 50 });
const guardianWallet = (index = 1) => createWalletClient({ chain: hardhat, account: mnemonicToAccount(MNEMONIC, { addressIndex: index }), transport: transport() });

async function deploy({ limit = 50, members = 5, each = 20 } = {}) {
  const signers = await ethers.getSigners();
  const [owner, guardian] = signers;
  const vault = await ethers.deployContract("GuardedVault", [guardian.address, ETH(limit)]);
  const receipt = await vault.deploymentTransaction().wait();
  const users = signers.slice(2, 2 + members);
  for (const u of users) await vault.connect(u).deposit({ value: ETH(each) });
  const info = { address: await vault.getAddress(), abi: (await artifacts.readArtifact("GuardedVault")).abi, startBlock: receipt.blockNumber };
  return { vault, info, owner, guardian, users, signers };
}

function makeMonitor(env, opts = {}) {
  const { owner, guardian, info } = env;
  return createMonitor({
    client: opts.client || viemClient(),
    vault: info,
    confirmations: 2,
    guardian: opts.guardian === undefined ? guardianWallet(1) : opts.guardian,
    ...opts,
    config: { knownAdmins: [owner.address, guardian.address], ...(opts.config || {}) },
  });
}

const mine = (n = 1) => network.provider.send("hardhat_mine", ["0x" + n.toString(16)]);
const later = async (sec) => { await network.provider.send("evm_increaseTime", [sec]); await mine(1); };
const rules = (alerts) => alerts.map((a) => a.rule);

module.exports = { ETH, viemClient, guardianWallet, deploy, makeMonitor, mine, later, rules };
