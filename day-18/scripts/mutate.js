// Mutation check: break one important line at a time and make sure the tests notice.
// Run: node scripts/mutate.js   (takes a few minutes; restores every file afterwards)
const fs = require("fs");
const { execSync } = require("child_process");

const L = "contracts/HimalFlashLender.sol";
const A = "contracts/FlashArbitrage.sol";
const S = "contracts/bonus/SafeBonus.sol";
const mutations = [
  [L, "callback answer not checked", "if (receiver.onFlashLoan(msg.sender, token, amount, fee, data) != CALLBACK_SUCCESS) revert CallbackFailed();", "receiver.onFlashLoan(msg.sender, token, amount, fee, data);"],
  [L, "repayment not pulled", "IERC20(token).safeTransferFrom(address(receiver), address(this), amount + fee);", ""],
  [L, "balance not re-checked", "if (balanceAfter < balanceBefore + fee) revert NotRepaid(balanceAfter, balanceBefore + fee);", ""],
  [L, "fee rounds down", "(amount * FEE_BPS + BPS - 1) / BPS", "(amount * FEE_BPS) / BPS"],
  [L, "no fee at all", "uint256 public constant FEE_BPS = 9;", "uint256 public constant FEE_BPS = 0;"],
  [L, "flashLoan not nonReentrant", "        nonReentrant\n        returns (bool)", "        returns (bool)"],
  [L, "no maximum-amount check", "if (amount > max) revert AmountTooLarge(amount, max);", ""],
  [L, "unsupported tokens lendable", "return supported[token] ? IERC20(token).balanceOf(address(this)) : 0;", "return IERC20(token).balanceOf(address(this));"],
  [L, "withdraw open to anyone", "external onlyOwner nonReentrant {", "external nonReentrant {"],
  [A, "lender not checked", "if (msg.sender != address(lender)) revert UntrustedLender(msg.sender);", ""],
  [A, "initiator not checked", "if (initiator != address(this)) revert UntrustedInitiator(initiator);", ""],
  [A, "minProfit ignored", "if (balance < owed || profit < t.minProfit) revert", "if (balance < owed) revert"],
  [A, "profit left in the bot", "IERC20(token).safeTransfer(owner(), profit);", ""],
  [A, "anyone can run the bot", "external onlyOwner returns (uint256 profit)", "external returns (uint256 profit)"],
  [S, "bonus reads today's balance", "him.getPastVotes(msg.sender, snapshotBlock)", "him.getVotes(msg.sender)"],
  [S, "snapshot may be in the future", "if (snapshotBlock_ >= block.number) revert SnapshotNotInPast(snapshotBlock_, block.number);", ""],
  [S, "claim twice", "claimed[msg.sender] = true;", ""],
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
    execSync("npx hardhat test", { stdio: "pipe", env: { ...process.env, FUZZ_RUNS: "20" } });
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
