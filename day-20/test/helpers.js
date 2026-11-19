const { ethers } = require("hardhat");

const E = (n) => ethers.parseEther(String(n));
const UNLOCK = 6 * 60 * 60; // profit unlocks over 6 hours

// The Day 20 world:
//   HUSD (a plain dollar token), HimalSavings (the strategy that pays interest),
//   the safe YieldVault, and a NaiveVault (vulnerable on purpose) to show the attack.
//   Everyone starts with 1,000,000 HUSD and has approved all three contracts.
async function baseFixture(unlockTime = UNLOCK) {
  const [deployer, ram, sita, hari, attacker, borrower] = await ethers.getSigners();
  const people = [deployer, ram, sita, hari, attacker, borrower];
  const husd = await ethers.deployContract("HimalToken", ["Himal USD", "HUSD", E(100_000_000), deployer.address]);
  const savings = await ethers.deployContract("HimalSavings", [await husd.getAddress()]);
  const vault = await ethers.deployContract("YieldVault", [await husd.getAddress(), await savings.getAddress(), unlockTime]);
  await savings.setVault(await vault.getAddress());
  const naive = await ethers.deployContract("NaiveVault", [await husd.getAddress()]);
  for (const p of people) {
    if (p !== deployer) await husd.transfer(p.address, E(1_000_000));
    for (const c of [vault, savings, naive]) await husd.connect(p).approve(await c.getAddress(), ethers.MaxUint256);
  }
  return { deployer, ram, sita, hari, attacker, borrower, husd, savings, vault, naive };
}

module.exports = { E, UNLOCK, baseFixture };
