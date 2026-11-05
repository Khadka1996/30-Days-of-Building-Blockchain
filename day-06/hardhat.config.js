const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");
require("@nomicfoundation/hardhat-ethers"); require("@nomicfoundation/hardhat-chai-matchers");
// Offline compiler: use the solcjs bundled in node_modules/solc instead of downloading
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  const solc = require("solc");
  return { compilerPath: require.resolve("solc/soljson.js"), isSolcJs: true, version: args.solcVersion, longVersion: solc.version() };
});
module.exports = {
  solidity: "0.8.24",
  networks: { hardhat: { accounts: { count: 50 } } }, // 50 test accounts for the "40 backers" test
};
