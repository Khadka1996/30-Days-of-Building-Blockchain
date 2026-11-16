// Mutation check: break one important line at a time and make sure the tests notice.
// Run: node scripts/mutate.js   (takes a few minutes; restores every file afterwards)
const fs = require("fs");
const { execSync } = require("child_process");

const P = "contracts/HimalPair.sol";
const R = "contracts/HimalRouter.sol";
const mutations = [
  [P, "no fee in the k check", "uint256 public constant FEE_PER_THOUSAND = 3;", "uint256 public constant FEE_PER_THOUSAND = 0;"],
  [P, "k check removed", "if (adj0 * adj1 < r0 * r1 * 1_000_000) revert KInvariant();", ""],
  [P, "no locked minimum liquidity", "_mint(DEAD, MINIMUM_LIQUIDITY);", ""],
  [P, "swap not nonReentrant", "address to) external nonReentrant {\n        if (amount0Out == 0", "address to) external {\n        if (amount0Out == 0"],
  [P, "prices from raw balances", "return (reserve0, reserve1);", "return (token0.balanceOf(address(this)), token1.balanceOf(address(this)));"],
  [P, "burn rounds up", "amount0 = (liquidity * bal0) / supply;", "amount0 = Math.mulDiv(liquidity, bal0, supply, Math.Rounding.Ceil);"],
  [P, "no reserve cap", "if (bal0 > MAX_RESERVE || bal1 > MAX_RESERVE) revert Overflow();", ""],
  [R, "deadline ignored", "if (block.timestamp > deadline)", "if (block.timestamp > deadline + 365 days)"],
  [R, "slippage limit ignored", "if (received < minOut) revert", "if (received < minOut && false) revert"],
  [R, "trusts the maths, not the balance", "uint256 received = tokenOut.balanceOf(to) - before;", "uint256 received = amounts[amounts.length - 1] + before * 0;"],
  [R, "getAmountIn rounds down", "* 997) + 1;", "* 997);"],
  [R, "getAmountOut ignores the fee", "uint256 inWithFee = amountIn * 997;", "uint256 inWithFee = amountIn * 1000;"],
  [R, "add-liquidity minimum ignored", "if (aOptimal < amountAMin) revert", "if (aOptimal < amountAMin && false) revert"],
  [R, "remove-liquidity minimum ignored", "if (amountA < amountAMin) revert", "if (amountA < amountAMin && false) revert"],
  [R, "bestPath ignores connectors", "uint256 n = connectors.length;", "uint256 n = 0;"],
  [R, "token order mixed up on remove", "tokenA < tokenB ? (amount0, amount1) : (amount1, amount0)", "tokenA < tokenB ? (amount1, amount0) : (amount0, amount1)"],
];

let caught = 0;
for (const [file, name, from, to] of mutations) {
  const orig = fs.readFileSync(file, "utf8");
  if (!orig.includes(from)) throw new Error(`mutation "${name}": text not found`);
  fs.writeFileSync(file, orig.replace(from, to));
  let failed = false;
  try {
    execSync("npx hardhat test", { stdio: "pipe", env: { ...process.env, FUZZ_RUNS: "40" } });
  } catch {
    failed = true;
  } finally {
    fs.writeFileSync(file, orig);
  }
  if (failed) caught++;
  console.log(`${failed ? "caught " : "MISSED "} ${name}`);
}
console.log(`\nmutation check: ${caught} of ${mutations.length} broken versions caught`);
process.exitCode = caught === mutations.length ? 0 : 1;
