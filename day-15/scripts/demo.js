// Day 15 demo: stake HIM, earn HRW every second, then the two attacks from the security focus.
// Run: npx hardhat run scripts/demo.js
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const E = (n) => ethers.parseEther(String(n));
const DAY = 24 * 60 * 60;
const WEEK = 7 * DAY;
const fmt = (wei, d = 18, dp = 2) =>
  Number(ethers.formatUnits(wei, d)).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const row = (label, value) => console.log(label.padEnd(50) + value);
const gas = async (txPromise) => (await (await txPromise).wait()).gasUsed.toString();

async function main() {
  const [owner, ram, sita, attacker] = await ethers.getSigners();
  const him = await ethers.deployContract("HimalToken", ["Himal Token", "HIM", E(1_000_000), owner.address]);
  const hrw = await ethers.deployContract("HimalToken", ["Himal Reward", "HRW", E(1_000_000), owner.address]);
  const staking = await ethers.deployContract("HimalStaking", [await him.getAddress(), await hrw.getAddress(), owner.address]);
  const pool = await staking.getAddress();
  for (const s of [ram, sita, attacker]) {
    await him.transfer(s.address, E(10_000));
    await him.connect(s).approve(pool, ethers.MaxUint256);
  }
  await hrw.approve(pool, ethers.MaxUint256);

  console.log("\n=== Himal Staking: lock HIM, earn HRW every second ===");
  row("Ram stakes 1,000 HIM", `gas used: ${await gas(staking.connect(ram).stake(E(1_000)))}`);
  const t0 = (await time.latest()) + 10;
  await time.setNextBlockTimestamp(t0);
  row("Owner adds 70,000 HRW for 7 days", `gas used: ${await gas(staking.notifyRewardAmount(E(70_000), WEEK))}`);
  row("Reward rate", `${fmt((await staking.rewardRateScaled()) / 10n ** 36n, 18, 6)} HRW per second`);
  await time.increaseTo(t0 + WEEK / 2);
  row("Day 3.5: Ram has earned", `${fmt(await staking.earned(ram.address))} HRW (alone so far)`);
  row("Day 3.5: Sita stakes 3,000 HIM", `gas used: ${await gas(staking.connect(sita).stake(E(3_000)))}`);
  await time.increaseTo(t0 + WEEK + 1);
  const r = await staking.earned(ram.address);
  const s = await staking.earned(sita.address);
  row("Day 7: Ram earned (1,000 HIM all week)", `${fmt(r)} HRW`);
  row("Day 7: Sita earned (3,000 HIM, half the week)", `${fmt(s)} HRW`);
  row("Paid out of 70,000", `${fmt(r + s)} HRW (lost to rounding: ${E(70_000) - r - s} wei)`);
  row("Ram claims", `gas used: ${await gas(staking.connect(ram).getReward())}`);
  row("Sita exits (withdraw + claim)", `gas used: ${await gas(staking.connect(sita).exit())}`);

  console.log("\n=== Attack 1: stake just before the payout, leave right after ===");
  const naive = await ethers.deployContract("NaiveLumpStaking", [await him.getAddress(), await hrw.getAddress()]);
  const n = await naive.getAddress();
  await him.connect(ram).approve(n, ethers.MaxUint256);
  await him.connect(attacker).approve(n, ethers.MaxUint256);
  await hrw.approve(n, ethers.MaxUint256);
  await naive.connect(ram).stake(E(1_000));
  await time.increase(30 * DAY);
  const a0 = await hrw.balanceOf(attacker.address);
  await naive.connect(attacker).stake(E(9_000));
  await naive.deposit(E(10_000));
  await naive.connect(attacker).getReward();
  await naive.connect(attacker).withdraw(E(9_000));
  const naiveGot = (await hrw.balanceOf(attacker.address)) - a0;
  row("NAIVE pool (pays deposits out at once)", `attacker took ${fmt(naiveGot)} of 10,000 HRW`);
  row("  Ram, staked for 30 days, got", `${fmt(E(10_000) - naiveGot)} HRW`);

  await time.increase(30 * DAY);
  const b0 = await hrw.balanceOf(attacker.address);
  await staking.connect(attacker).stake(E(9_000));
  await staking.notifyRewardAmount(E(70_000), WEEK);
  await staking.connect(attacker).exit();
  const himalGot = (await hrw.balanceOf(attacker.address)) - b0;
  row("HIMAL pool (pays per second)", `attacker took ${fmt(himalGot, 18, 4)} of 70,000 HRW`);

  console.log("\n=== Attack 2: rounding (a 6-decimal dollar token, like USDC) ===");
  const usd = await ethers.deployContract("SixDecimalToken", [10n ** 12n]);
  const classic = await ethers.deployContract("ClassicStaking", [await him.getAddress(), await usd.getAddress()]);
  const himal = await ethers.deployContract("HimalStaking", [await him.getAddress(), await usd.getAddress(), owner.address]);
  for (const p of [classic, himal]) {
    await usd.approve(await p.getAddress(), ethers.MaxUint256);
    await him.connect(ram).approve(await p.getAddress(), ethers.MaxUint256);
    await p.connect(ram).stake(E(1_000));
  }
  const ramUsd0 = await usd.balanceOf(ram.address);
  await classic.notifyRewardAmount(100_000_000n, 365 * DAY);
  await himal.notifyRewardAmount(100_000_000n, 365 * DAY);
  row("100 USD6 over 1 year: classic rate per second", `${await classic.rewardRate()} units (true value 3.17)`);
  await time.increase(366 * DAY);
  await classic.connect(ram).getReward();
  const c = (await usd.balanceOf(ram.address)) - ramUsd0;
  await himal.connect(ram).getReward();
  const h = (await usd.balanceOf(ram.address)) - ramUsd0 - c;
  row("CLASSIC paid", `${fmt(c, 6, 6)} USD6 (stuck forever: ${fmt(100_000_000n - c, 6, 6)})`);
  row("HIMAL paid (rate scaled by 1e36)", `${fmt(h, 6, 6)} USD6`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
