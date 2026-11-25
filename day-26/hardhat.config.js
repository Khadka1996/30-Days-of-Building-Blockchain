const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");
require("@nomicfoundation/hardhat-ethers"); require("@nomicfoundation/hardhat-chai-matchers");
// Offline compiler: use the solcjs bundled in node_modules/solc instead of downloading
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  const solc = require("solc");
  return { compilerPath: require.resolve("solc/soljson.js"), isSolcJs: true, version: args.solcVersion, longVersion: solc.version() };
});

// Day 26 runs TWO local chains. `scripts/chains.js` starts `hardhat node` twice with
// different CHAIN_ID / port; each node reads its chain ID from the environment.
module.exports = {
  solidity: { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 200 } } },
  networks: {
    hardhat: { chainId: Number(process.env.CHAIN_ID || 31337) },
    l1: { url: process.env.L1_RPC || "http://127.0.0.1:8545", chainId: 31337 },
    l2: { url: process.env.L2_RPC || "http://127.0.0.1:8546", chainId: 31338 },
  },
};
