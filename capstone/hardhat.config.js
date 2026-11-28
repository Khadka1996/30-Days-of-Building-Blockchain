const fs = require("node:fs");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");
require("@nomicfoundation/hardhat-ethers"); require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-verify");
// Offline compiler: use the solcjs bundled in node_modules/solc instead of downloading
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  const solc = require("solc");
  return { compilerPath: require.resolve("solc/soljson.js"), isSolcJs: true, version: args.solcVersion, longVersion: solc.version() };
});

// Deploy kit (Day 29): read capstone/.env if present (never committed; see .env.example).
if (fs.existsSync(`${__dirname}/.env`)) {
  for (const line of fs.readFileSync(`${__dirname}/.env`, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const { SEPOLIA_RPC_URL, DEPLOYER_PRIVATE_KEY, ETHERSCAN_API_KEY } = process.env;

module.exports = {
  solidity: { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 200 } } },
  networks: {
    hardhat: { chainId: 31337 },
    localhost: { url: "http://127.0.0.1:8545", chainId: 31337 },
    // Only defined when both values are set, so tests never need a key.
    ...(SEPOLIA_RPC_URL && DEPLOYER_PRIVATE_KEY ? { sepolia: { url: SEPOLIA_RPC_URL, chainId: 11155111, accounts: [DEPLOYER_PRIVATE_KEY] } } : {}),
  },
  etherscan: { apiKey: ETHERSCAN_API_KEY || "" },
  sourcify: { enabled: false },
  mocha: { timeout: 120000 },
};
