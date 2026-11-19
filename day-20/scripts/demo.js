// Day 20 demo: deposit HUSD into the yield vault, invest it, earn interest, share the profit,
// then three attacks: the first-depositor inflation attack (naive vs safe vault), profit sniping
// (no lock vs a 6-hour lock) and exiting at the old price after a loss.
// Run: npx hardhat run scripts/demo.js
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { E, UNLOCK, baseFixture } = require("../test/helpers");

const fmt = (wei, dp = 2) =>
  Number(ethers.formatUnits(wei, 18)).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const row = (label, value) => console.log(label.padEnd(52) + value);
const gas = async (txPromise) => (await (await txPromise).wait()).gasUsed.toString();
const ONE_SHARE = 10n ** 24n;

async function redeemAll(vault, who) {
  return vault.connect(who).redeem(await vault.balanceOf(who.address), who.address, who.address);
}

async function main() {
  // ------------------------------------------------------------------ the happy path
  let f = await baseFixture();
  let { vault, savings, husd, ram, sita, borrower } = f;
  console.log("\n=== Himal Yield Vault: deposit HUSD, the vault invests it ===");
  row("Ram deposits 1,000 HUSD", `gas used: ${await gas(vault.connect(ram).deposit(E(1000), ram.address))}`);
  row("  Ram's shares (24 decimals: 6 virtual)", `${fmt(await vault.balanceOf(ram.address) / 10n ** 6n)} hyHUSD`);
  await vault.connect(sita).deposit(E(3000), sita.address);
  row("Sita deposits 3,000 HUSD", `total ${fmt(await vault.totalAssets())} HUSD`);
  row("invest(): 90% to HimalSavings, 10% kept as cash", `gas used: ${await gas(vault.invest())}`);
  row("  cash / in the strategy", `${fmt(await vault.idle())} / ${fmt(await savings.totalAssets())}`);

  console.log("\n=== Borrowers pay 400 HUSD interest: profit unlocks over 6 hours ===");
  await savings.connect(borrower).payInterest(E(400));
  row("harvest() records 400 HUSD profit", `gas used: ${await gas(vault.harvest())}`);
  row("  value of 1 share right after the harvest", `${fmt(await vault.convertToAssets(ONE_SHARE), 4)} HUSD`);
  await time.increase(UNLOCK / 2);
  row("  after 3 hours", `${fmt(await vault.convertToAssets(ONE_SHARE), 4)} HUSD`);
  await time.increase(UNLOCK / 2);
  row("  after 6 hours", `${fmt(await vault.convertToAssets(ONE_SHARE), 4)} HUSD`);
  let b = await husd.balanceOf(ram.address);
  await redeemAll(vault, ram);
  row("Ram redeems everything (put in 1,000)", `${fmt((await husd.balanceOf(ram.address)) - b, 6)} HUSD`);
  b = await husd.balanceOf(sita.address);
  row("Sita redeems everything (put in 3,000)", `gas used: ${await gas(redeemAll(vault, sita))}`);
  row("  Sita receives", `${fmt((await husd.balanceOf(sita.address)) - b, 6)} HUSD`);

  // ------------------------------------------------------------------ attack 1: inflation
  console.log("\n=== Attack 1: the first-depositor inflation attack ===");
  f = await baseFixture();
  let { naive, attacker } = f;
  ({ vault, savings, husd, ram } = f);
  let a0 = await husd.balanceOf(attacker.address);
  await naive.connect(attacker).deposit(1n);
  await husd.connect(attacker).transfer(await naive.getAddress(), E(1000));
  row("NAIVE vault: attacker puts in 1 wei + gives 1,000", "1 share = 1,000 HUSD");
  await naive.connect(ram).deposit(E(1000));
  row("  Ram deposits 1,000 HUSD and receives", `${await naive.balanceOf(ram.address)} shares`);
  await naive.connect(attacker).redeem(1n);
  row("  attacker redeems 1 share: profit", `+${fmt((await husd.balanceOf(attacker.address)) - a0)} HUSD (all of Ram's)`);

  a0 = await husd.balanceOf(attacker.address);
  await vault.connect(attacker).deposit(1n, attacker.address);
  await husd.connect(attacker).transfer(await vault.getAddress(), E(1000));
  row("SAFE vault, same donation", `totalAssets still ${await vault.totalAssets()} wei (ignored)`);
  await vault.connect(ram).deposit(E(1000), ram.address);
  row("  Ram's 1,000 HUSD deposit is worth", `${fmt(await vault.previewRedeem(await vault.balanceOf(ram.address)), 6)} HUSD`);
  await redeemAll(vault, attacker);
  row("  attacker's result", `${fmt((await husd.balanceOf(attacker.address)) - a0)} HUSD`);

  f = await baseFixture();
  ({ vault, savings, husd, ram, attacker } = f);
  a0 = await husd.balanceOf(attacker.address);
  await vault.connect(attacker).deposit(1n, attacker.address);
  await savings.connect(attacker).payInterest(E(1000));
  await vault.harvest();
  await time.increase(UNLOCK);
  row("SAFE vault, donation as 'interest' + 6 h wait", `attacker's 1 wei is now worth ${fmt(await vault.previewRedeem(await vault.balanceOf(attacker.address)))} HUSD`);
  await vault.connect(ram).deposit(E(1000), ram.address);
  const ramValue = await vault.previewRedeem(await vault.balanceOf(ram.address));
  row("  Ram's 1,000 HUSD deposit is worth", `${fmt(ramValue, 6)} HUSD (loss ${fmt(E(1000) - ramValue, 6)})`);
  await redeemAll(vault, attacker);
  row("  attacker's result (virtual shares keep the rest)", `${fmt((await husd.balanceOf(attacker.address)) - a0)} HUSD`);

  // ------------------------------------------------------------------ attack 2: profit sniping
  console.log("\n=== Attack 2: profit sniping (jump in just before a harvest) ===");
  for (const [label, unlock] of [["NO lock (1 second)", 1], ["6-hour lock", UNLOCK]]) {
    f = await baseFixture(unlock);
    const { hari } = f;
    ({ vault, savings, husd, ram, sita, borrower } = f);
    await vault.connect(ram).deposit(E(1000), ram.address);
    await vault.connect(sita).deposit(E(3000), sita.address);
    await vault.invest();
    await savings.connect(borrower).payInterest(E(400));
    const h0 = await husd.balanceOf(hari.address);
    await vault.connect(hari).deposit(E(100_000), hari.address);
    await vault.harvest();
    await redeemAll(vault, hari);
    const gain = (await husd.balanceOf(hari.address)) - h0;
    row(`${label}: Hari in 100,000, harvest, out`, `+${fmt(gain, 4)} HUSD of the 400 (${((Number(gain) / 4e20) * 100).toFixed(3)}%)`);
  }

  // ------------------------------------------------------------------ attack 3: exit after a loss
  console.log("\n=== Attack 3: a borrower defaults on 1,000 HUSD (25% of the vault) ===");
  f = await baseFixture();
  ({ vault, savings, husd, ram, sita } = f);
  await vault.connect(ram).deposit(E(1000), ram.address);
  await vault.connect(sita).deposit(E(3000), sita.address);
  await vault.invest();
  await savings.simulateLoss(E(1000), f.deployer.address);
  row("totalAssets before anyone calls harvest()", `${fmt(await vault.totalAssets())} HUSD (loss counted at once)`);
  b = await husd.balanceOf(ram.address);
  await redeemAll(vault, ram);
  row("Ram rushes to exit with his 1,000", `${fmt((await husd.balanceOf(ram.address)) - b, 6)} HUSD (fair: -25%, like Sita)`);
  row("Sita's 3,000 is now worth", `${fmt(await vault.previewRedeem(await vault.balanceOf(sita.address)), 6)} HUSD`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
