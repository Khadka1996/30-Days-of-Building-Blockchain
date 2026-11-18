// Mutation check: break one important line at a time and make sure the tests notice.
// Run: node scripts/mutate.js   (takes a few minutes; restores every file afterwards)
const fs = require("fs");
const { execSync } = require("child_process");

const D = "contracts/DollarEngine.sol";
const T = "contracts/EverestDollar.sol";
const mutations = [
  [D, "mint skips the 150% check", "_requireHealthy(v, _price());\n        emit Minted", "emit Minted"],
  [D, "withdraw skips the 150% check", "if (v.debt != 0) _requireHealthy(v, _price());", ""],
  [D, "old prices accepted", " || block.timestamp - updatedAt > MAX_PRICE_AGE", ""],
  [D, "prices from the future accepted", "updatedAt == 0 || updatedAt > block.timestamp ||", "updatedAt == 0 ||"],
  [D, "circuit-breaker band ignored", "if (answer <= _feedMin || answer >= _feedMax)", "if (answer <= 0)"],
  [D, "unfinished rounds accepted", "if (answeredInRound < roundId) revert IncompleteRound(roundId, answeredInRound);", ""],
  [D, "healthy vaults can be liquidated", "if (debt == 0 || value * WAD >= debt * MIN_RATIO) revert", "if (debt == 0) revert"],
  [D, "no close factor (whole debt at once)", "uint256 maxRepay = (debt * CLOSE_FACTOR) / WAD;", "uint256 maxRepay = debt;"],
  [D, "liquidation bonus 20%", "LIQ_BONUS = 0.1e18", "LIQ_BONUS = 0.2e18"],
  [D, "closing zone allows a small repay", "if (amount < needed) revert RepayTooSmall(amount, needed);", ""],
  [D, "closing zone leaves ETH behind", "            seized = v.collateral;\n        }", "            seized = (amount * (WAD + LIQ_BONUS)) / px;\n        }"],
  [D, "bad debt hidden", "badDebt += written;", ""],
  [D, "no debt ceiling", "if (newTotal > debtCeiling) revert CeilingReached(newTotal, debtCeiling);", ""],
  [D, "dust debt allowed", "if (newDebt < MIN_DEBT) revert DustDebt(newDebt);", ""],
  [D, "mint not nonReentrant", "function mint(uint256 amount) public nonReentrant {", "function mint(uint256 amount) public {"],
  [D, "withdraw not nonReentrant", "function withdraw(uint256 amount) external nonReentrant {", "function withdraw(uint256 amount) external {"],
  [D, "repay burns nothing", "emit Repaid(msg.sender, amount);\n        eusd.burn(msg.sender, amount);", "emit Repaid(msg.sender, amount);"],
  [D, "backing reads the raw ETH balance", "_value(totalCollateral, _price())", "_value(address(this).balance, _price())"],
  [T, "anyone can mint EUSD", "if (msg.sender != engine) revert OnlyEngine(msg.sender);", ""],
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
