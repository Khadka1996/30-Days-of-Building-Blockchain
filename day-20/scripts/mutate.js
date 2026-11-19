// Mutation check: break one important line at a time and make sure the tests notice.
// Run: node scripts/mutate.js   (takes a few minutes; restores every file afterwards)
const fs = require("fs");
const { execSync } = require("child_process");

const V = "contracts/YieldVault.sol";
const S = "contracts/HimalSavings.sol";
const mutations = [
  [V, "no virtual shares (offset 0)", "return 6;", "return 0;"],
  [V, "cash read from the raw token balance", "return idle + inStrategy - locked;", "return IERC20(asset()).balanceOf(address(this)) + inStrategy - locked;"],
  [V, "no profit lock", "if (block.timestamp >= unlockEnd) return 0;", "return 0;"],
  [V, "harvest restarts the full unlock clock (griefable)", "remaining = (locked * remaining + profit * profitUnlockTime + locked + profit - 1) / (locked + profit);", "remaining = profitUnlockTime;"],
  [V, "unharvested profit counted at once", "inStrategy = strategyAssets; // unharvested profit is not counted yet", ""],
  [V, "losses ignored until a harvest", "inStrategy = strategy.totalAssets();\n        locked = lockedProfit();", "inStrategy = strategyAssets;\n        locked = lockedProfit();"],
  [V, "a loss does not eat locked profit (view)", "            uint256 loss = strategyAssets - inStrategy;\n            locked = loss >= locked ? 0 : locked - loss;", "            uint256 loss = strategyAssets - inStrategy;"],
  [V, "invest ignores the 10% cash buffer", "amount = idle - target;", "amount = idle;"],
  [V, "harvest with nothing new restarts the clock", "if (current == previous) return (0, 0);", ""],
  [V, "withdrawal forgets money left the strategy", "            strategyAssets -= pull;\n", ""],
  [V, "depositWithMin has no limit", "if (shares < minShares) revert TooFewShares(shares, minShares);", ""],
  [V, "redeemWithMin has no limit", "if (assets < minAssets) revert TooFewAssets(assets, minAssets);", ""],
  [S, "anyone can take money out of the strategy", "function withdraw(uint256 amount) external onlyVault {", "function withdraw(uint256 amount) external {"],
  [S, "the vault can be replaced", "if (vault != address(0)) revert VaultAlreadySet();", ""],
];

// If the run is stopped half-way (Ctrl-C), put the original file back before exiting.
let restore = null;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (restore) restore();
    process.exit(130);
  });
}

let caught = 0;
for (const [file, name, from, to] of mutations) {
  const orig = fs.readFileSync(file, "utf8");
  restore = () => fs.writeFileSync(file, orig);
  if (!orig.includes(from)) throw new Error(`mutation "${name}": text not found`);
  fs.writeFileSync(file, orig.replace(from, to));
  let failed = false;
  try {
    execSync("npx hardhat test", { stdio: "pipe", env: { ...process.env, FUZZ_RUNS: "40" } });
  } catch {
    failed = true;
  } finally {
    restore();
    restore = null;
  }
  if (failed) caught++;
  console.log(`${failed ? "caught " : "MISSED "} ${name}`);
}
console.log(`\nmutation check: ${caught} of ${mutations.length} broken versions caught`);
process.exitCode = caught === mutations.length ? 0 : 1;
