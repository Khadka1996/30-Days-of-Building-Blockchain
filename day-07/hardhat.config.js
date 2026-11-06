const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-verify");
require("dotenv").config({ quiet: true }); // reads .env (never committed); see .env.example

const { assertPrivateKeyFormat } = require("./lib/deployKit");

// Offline compiler: use the solcjs bundled in node_modules/solc instead of downloading
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  const solc = require("solc");
  return { compilerPath: require.resolve("solc/soljson.js"), isSolcJs: true, version: args.solcVersion, longVersion: solc.version() };
});

const { SEPOLIA_RPC_URL, PRIVATE_KEY, ETHERSCAN_API_KEY } = process.env;

// The Sepolia network only exists when BOTH the RPC URL and a well-formed key
// are set. A malformed key stops Hardhat at once, before anything is sent.
const networks = {};
if (Boolean(SEPOLIA_RPC_URL) !== Boolean(PRIVATE_KEY)) {
  // Half a setup is almost always a typo in .env: say so instead of a vague "network not found".
  throw new Error("Set BOTH SEPOLIA_RPC_URL and PRIVATE_KEY in .env (or neither for local runs).");
}
if (SEPOLIA_RPC_URL && PRIVATE_KEY) {
  assertPrivateKeyFormat(PRIVATE_KEY);
  networks.sepolia = { url: SEPOLIA_RPC_URL, accounts: [PRIVATE_KEY], chainId: 11155111 };
}

module.exports = {
  // Same compiler and settings as Days 1–6, so the bytecode on Etherscan matches.
  solidity: { version: "0.8.24", settings: { optimizer: { enabled: false, runs: 200 } } },
  networks,
  etherscan: { apiKey: ETHERSCAN_API_KEY || "" },
  sourcify: { enabled: false },
};
