const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const E = (n) => ethers.parseEther(String(n));
const P = (usd) => BigInt(Math.round(usd * 1e8)); // price-feed units (8 decimals)
const DAY = 24 * 60 * 60;
const YEAR = 365 * DAY;

// HUSD (lent and borrowed) and HIM (collateral), 10,000,000 each, minted to the owner.
// The owner also runs the price feed (1 HIM = $10 to start).
// Ram and Sita are lenders, Hari and Mina borrowers, Gita a liquidator. Everyone approves the pool.
async function baseFixture() {
  const [owner, ram, sita, hari, mina, gita, attacker] = await ethers.getSigners();
  const husd = await ethers.deployContract("HimalToken", ["Himal Dollar", "HUSD", E(10_000_000), owner.address]);
  const him = await ethers.deployContract("HimalToken", ["Himal Token", "HIM", E(10_000_000), owner.address]);
  const feed = await ethers.deployContract("HimalPriceFeed", [P(10), owner.address]);
  const lend = await ethers.deployContract("HimalLend", [
    await husd.getAddress(), await him.getAddress(), await feed.getAddress(), owner.address,
  ]);
  const pool = await lend.getAddress();
  for (const s of [owner, ram, sita, hari, mina, gita, attacker]) {
    if (s !== owner) {
      await husd.transfer(s.address, E(100_000));
      await him.transfer(s.address, E(100_000));
    }
    await husd.connect(s).approve(pool, ethers.MaxUint256);
    await him.connect(s).approve(pool, ethers.MaxUint256);
  }
  return { owner, ram, sita, hari, mina, gita, attacker, husd, him, feed, lend, pool };
}

// The standard story: Ram and Sita lend 10,000 HUSD each; Hari locks 1,000 HIM ($10,000) and borrows 7,000.
async function borrowedFixture() {
  const f = await baseFixture();
  await f.lend.connect(f.ram).deposit(E(10_000));
  await f.lend.connect(f.sita).deposit(E(10_000));
  await f.lend.connect(f.hari).depositCollateral(E(1_000));
  await f.lend.connect(f.hari).borrow(E(7_000));
  return f;
}

// Move time forward and post a fresh price (a real feed updates at least every hour).
async function wait(f, seconds, usd) {
  await time.increase(seconds);
  await f.feed.setPrice(P(usd));
}

module.exports = { E, P, DAY, YEAR, baseFixture, borrowedFixture, wait };
