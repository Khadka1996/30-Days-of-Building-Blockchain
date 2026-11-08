// Quick demo on the local Hardhat network: 12,000 HIM vest over 12 months with a 3-month cliff.
// Ram claims along the way; Sita leaves after 6 months and her schedule is revoked.
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const MONTH = 30 * 24 * 60 * 60;
const HIM = (n) => ethers.parseEther(String(n));
const fmt = (wei) => Number(ethers.formatEther(wei)).toLocaleString("en-US", { maximumFractionDigits: 2 });
const say = (label, value) => console.log(label.padEnd(46), value);

async function main() {
  const [, ram, sita] = await ethers.getSigners();
  const token = await ethers.deployContract("HimalToken");
  const vesting = await ethers.deployContract("TokenVesting", [await token.getAddress()]);
  const addr = await vesting.getAddress();
  await (await token.transfer(addr, HIM(24000))).wait();

  const start = (await time.latest()) + 100;
  const r1 = await (await vesting.createSchedule(ram.address, HIM(12000), start, 3 * MONTH, 12 * MONTH, false)).wait();
  await (await vesting.createSchedule(sita.address, HIM(12000), start, 3 * MONTH, 12 * MONTH, true)).wait();
  say("Schedule", "12,000 HIM, 12 months, 3-month cliff");
  say("Create a schedule", `gas used: ${r1.gasUsed}`);

  console.log("\nMonth   Unlocked (HIM)");
  for (const m of [0, 1, 2, 3, 6, 9, 12]) {
    console.log(String(m).padEnd(7), fmt(await vesting.vestedAt(ram.address, start + m * MONTH)));
  }
  console.log("");

  const at = async (t) => time.setNextBlockTimestamp(t);
  await at(start + 3 * MONTH - 1);
  try {
    await vesting.connect(ram).release();
  } catch (e) {
    say("Ram claims 1 second before the cliff:", "reverted with NothingToRelease");
  }

  await at(start + 3 * MONTH);
  let r = await (await vesting.connect(ram).release()).wait();
  say("Ram claims at the cliff (month 3)", `gas used: ${r.gasUsed}`);
  say("Ram's balance", `${fmt(await token.balanceOf(ram.address))} HIM`);

  await at(start + 6 * MONTH);
  const rv = await (await vesting.revoke(sita.address)).wait();
  say("Sita leaves at month 6; owner revokes", `gas used: ${rv.gasUsed}`);
  say("Sita can still claim", `${fmt(await vesting.releasable(sita.address))} HIM (what she earned)`);
  say("Returned to spare tokens", `${fmt(await vesting.spareTokens())} HIM`);

  await at(start + 12 * MONTH);
  await (await vesting.connect(ram).release()).wait();
  await (await vesting.connect(sita).release()).wait();
  say("Ram's final balance (month 12)", `${fmt(await token.balanceOf(ram.address))} HIM`);
  say("Sita's final balance", `${fmt(await token.balanceOf(sita.address))} HIM`);
  say("Still owed by the contract", `${fmt(await vesting.totalOwed())} HIM`);

  // Rounding: 1,000 wei paid out over 365 daily claims, against the naive method.
  const v2 = await ethers.deployContract("TokenVesting", [await token.getAddress()]);
  await (await token.transfer(await v2.getAddress(), 1000n)).wait();
  const day = 24 * 60 * 60;
  const [, , , eve] = await ethers.getSigners();
  const s2 = (await time.latest()) + 100;
  await (await v2.createSchedule(eve.address, 1000n, s2, 0, 365 * day, false)).wait();
  for (let d = 1; d <= 365; d++) {
    await at(s2 + d * day);
    await (await v2.connect(eve).release()).wait();
  }
  console.log("\n--- rounding: 1,000 wei claimed daily for 365 days ---");
  say("This contract pays", `${await token.balanceOf(eve.address)} wei`);
  say("Naive 'time since last claim' maths pays", `${(1000n * BigInt(day) / BigInt(365 * day)) * 365n} wei`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
