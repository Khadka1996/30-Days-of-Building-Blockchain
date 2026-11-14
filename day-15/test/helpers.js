const { ethers } = require("hardhat");

const E = (n) => ethers.parseEther(String(n));
const DAY = 24 * 60 * 60;
const WEEK = 7 * DAY;

// HIM (staked) and HRW (rewards): 1,000,000 each, minted to the deployer, who owns the pool.
// Ram, Sita and the attacker get 10,000 HIM each and approve the pool.
async function baseFixture() {
  const [owner, ram, sita, attacker, hari] = await ethers.getSigners();
  const him = await ethers.deployContract("HimalToken", ["Himal Token", "HIM", E(1_000_000), owner.address]);
  const hrw = await ethers.deployContract("HimalToken", ["Himal Reward", "HRW", E(1_000_000), owner.address]);
  const staking = await ethers.deployContract("HimalStaking", [await him.getAddress(), await hrw.getAddress(), owner.address]);
  const pool = await staking.getAddress();

  for (const s of [ram, sita, attacker, hari]) {
    await him.transfer(s.address, E(10_000));
    await him.connect(s).approve(pool, ethers.MaxUint256);
  }
  await hrw.approve(pool, ethers.MaxUint256);
  return { owner, ram, sita, attacker, hari, him, hrw, staking, pool };
}

// Exact JavaScript copy of HimalStaking's integer maths, used by the fuzz tests.
class Model {
  constructor() {
    this.P = 10n ** 36n;
    this.periodFinish = 0n; this.rate = 0n; this.last = 0n; this.rpt = 0n; this.unalloc = 0n;
    this.total = 0n; this.bal = {}; this.paid = {}; this.rew = {};
  }
  applicable(now) { return now < this.periodFinish ? now : this.periodFinish; }
  rewardPerToken(now) {
    if (this.total === 0n) return this.rpt;
    return this.rpt + ((this.applicable(now) - this.last) * this.rate) / this.total;
  }
  earned(a, now) {
    return (this.rew[a] || 0n) + ((this.bal[a] || 0n) * (this.rewardPerToken(now) - (this.paid[a] || 0n))) / this.P;
  }
  update(a, now) {
    const app = this.applicable(now);
    const elapsed = app - this.last;
    if (elapsed > 0n) {
      if (this.total === 0n) this.unalloc += elapsed * this.rate;
      else this.rpt += (elapsed * this.rate) / this.total;
    }
    this.last = app;
    if (a !== null) { this.rew[a] = this.earned(a, now); this.paid[a] = this.rpt; }
  }
  stake(a, amt, now) { this.update(a, now); this.total += amt; this.bal[a] = (this.bal[a] || 0n) + amt; }
  withdraw(a, amt, now) { this.update(a, now); this.bal[a] -= amt; this.total -= amt; }
  claim(a, now) { this.update(a, now); const r = this.rew[a]; this.rew[a] = 0n; return r; }
  notify(reward, duration, now) {
    this.update(null, now);
    let t = reward * this.P + this.unalloc;
    this.unalloc = 0n;
    if (now < this.periodFinish) t += (this.periodFinish - now) * this.rate;
    this.rate = t / duration; this.last = now; this.periodFinish = now + duration;
  }
}

module.exports = { E, DAY, WEEK, baseFixture, Model };
