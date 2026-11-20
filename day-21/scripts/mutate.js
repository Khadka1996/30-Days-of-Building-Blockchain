// Mutation check: plant one bug at a time in the Week 3 contracts and the upgrade contracts,
// and make sure the Day 21 tests (invariants + upgrade tests) notice every one.
// Run: npm run mutate   (about 3–4 minutes; restores every file afterwards)
const fs = require("fs");
const { execSync } = require("child_process");

const W = "contracts/week3/";
const U = "contracts/upgrade/";
const mutations = [
  // Day 15 staking (caught by the side-by-side proxy comparison and the solvency checks)
  [W + "HimalStaking.sol", "staking: withdraw forgets to lower totalStaked", "totalStaked -= amount;\n        stakingToken", "stakingToken"],
  [W + "HimalStaking.sol", "staking: a claim does not reset your rewards", "rewards[msg.sender] = 0;", ""],
  [U + "HimalStakingV1.sol", "proxy V1: unallocated rewards paid twice", "unallocatedScaled = 0;", ""],
  // Day 17 swap pool
  [W + "HimalPair.sol", "swap: no 0.3% fee in the k check", "FEE_PER_THOUSAND = 3;", "FEE_PER_THOUSAND = 0;"],
  [W + "HimalPair.sol", "swap: the 1,000 first LP shares are not locked", "_mint(DEAD, MINIMUM_LIQUIDITY);", "_mint(to, MINIMUM_LIQUIDITY);"],
  // Day 16 lending
  [W + "HimalLend.sol", "lending: borrow skips the health check", "totalDebtShares += shares;\n        if (debtOf(msg.sender) > maxBorrow(msg.sender)) revert Unhealthy();", "totalDebtShares += shares;"],
  [W + "HimalLend.sol", "lending: collateral withdrawal skips the health check", "if (debtSharesOf[msg.sender] != 0 && debtOf(msg.sender) > maxBorrow(msg.sender)) revert Unhealthy();", ""],
  [W + "HimalLend.sol", "lending: redeem forgets the cash left", "totalCash -= assets;", ""],
  // Day 20 vault
  [W + "YieldVault.sol", "vault: profit counted at once (no 6-hour unlock)", "if (block.timestamp >= unlockEnd) return 0;", "return 0;"],
  [W + "YieldVault.sol", "vault: withdrawal forgets money left the strategy", "            strategyAssets -= pull;\n", ""],
  // Day 21 upgrade safety
  [U + "HimalStakingV1.sol", "upgrade: anyone can upgrade (no onlyOwner)", "internal virtual override onlyOwner {}", "internal virtual override {}"],
  [U + "HimalStakingV1.sol", "upgrade: logic contract not locked", "        _disableInitializers();\n    }\n\n    /// @notice Runs once", "    }\n\n    /// @notice Runs once"],
  [U + "HimalStakingV2.sol", "upgrade: anyone can run the V2 setup", "reinitializer(2) onlyOwner", "reinitializer(2)"],
  [U + "HimalStakingV2.sol", "upgrade: anyone can pause", "if (msg.sender != guardian && msg.sender != owner()) revert NotGuardian();", ""],
  [U + "HimalStakingV2.sol", "upgrade: the pause does nothing", "if (stakingPaused) revert StakingIsPaused();", ""],
];

let restore = null;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (restore) restore();
    process.exit(130);
  });
}

// Optional: ONLY=vault npm run mutate  runs just the mutations whose name contains "vault".
const selected = mutations.filter(([, name]) => !process.env.ONLY || name.includes(process.env.ONLY));
let caught = 0;
for (const [file, name, from, to] of selected) {
  const orig = fs.readFileSync(file, "utf8");
  restore = () => fs.writeFileSync(file, orig);
  if (orig.split(from).length !== 2) throw new Error(`mutation "${name}": text not found exactly once`);
  fs.writeFileSync(file, orig.replace(from, to));
  let failed = false;
  try {
    // A planted bug must still compile; otherwise the mutation itself is broken.
    execSync("npx hardhat compile --quiet", { stdio: "pipe" });
  } catch {
    restore();
    throw new Error(`mutation "${name}" does not compile`);
  }
  try {
    execSync("npx hardhat test", { stdio: "pipe", env: { ...process.env, FUZZ_RUNS: process.env.FUZZ_RUNS || "15" } });
  } catch {
    failed = true;
  } finally {
    restore();
    restore = null;
  }
  if (failed) caught++;
  console.log(`${failed ? "caught " : "MISSED "} ${name}`);
}
console.log(`\nmutation check: ${caught} of ${selected.length} planted bugs caught`);
process.exitCode = caught === selected.length ? 0 : 1;
