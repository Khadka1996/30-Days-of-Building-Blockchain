const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { E, DAY, WEEK, baseFixture } = require("./helpers");

// Tiny rounding dust (in wei) we accept: far below 0.000001 of a token.
const DUST = 10n ** 9n;

// Mine the next transaction at exactly `t` seconds.
const at = (t) => time.setNextBlockTimestamp(t);

describe("HimalStaking — setup and access control", function () {
  it("rejects zero addresses and using the same token for staking and rewards", async function () {
    const { him, hrw, owner } = await loadFixture(baseFixture);
    const F = await ethers.getContractFactory("HimalStaking");
    const h = await him.getAddress();
    await expect(F.deploy(ethers.ZeroAddress, await hrw.getAddress(), owner.address)).to.be.revertedWithCustomError(F, "ZeroAddress");
    await expect(F.deploy(h, ethers.ZeroAddress, owner.address)).to.be.revertedWithCustomError(F, "ZeroAddress");
    await expect(F.deploy(h, h, owner.address)).to.be.revertedWithCustomError(F, "SameToken");
  });

  it("only the owner can add rewards, and the duration must be 1 to 365 days", async function () {
    const { staking, ram } = await loadFixture(baseFixture);
    await expect(staking.connect(ram).notifyRewardAmount(E(1), WEEK)).to.be.revertedWithCustomError(staking, "OwnableUnauthorizedAccount");
    await expect(staking.notifyRewardAmount(E(1), DAY - 1)).to.be.revertedWithCustomError(staking, "BadDuration");
    await expect(staking.notifyRewardAmount(E(1), 365 * DAY + 1)).to.be.revertedWithCustomError(staking, "BadDuration");
    await expect(staking.notifyRewardAmount(0, WEEK)).to.be.revertedWithCustomError(staking, "ZeroAmount");
  });

  it("rewards are pulled in first, so the pool never promises tokens it does not hold", async function () {
    const { staking, hrw, pool } = await loadFixture(baseFixture);
    await staking.notifyRewardAmount(E(70_000), WEEK);
    expect(await hrw.balanceOf(pool)).to.equal(E(70_000));
    await hrw.approve(pool, 0);
    await expect(staking.notifyRewardAmount(E(1), WEEK)).to.be.revertedWithCustomError(hrw, "ERC20InsufficientAllowance");
  });

  it("the owner can rescue stray tokens but never the staked HIM or the HRW rewards", async function () {
    const { staking, him, hrw, owner, ram } = await loadFixture(baseFixture);
    await staking.connect(ram).stake(E(1_000));
    await expect(staking.recoverERC20(await him.getAddress(), 1)).to.be.revertedWithCustomError(staking, "CannotRecoverThisToken");
    await expect(staking.recoverERC20(await hrw.getAddress(), 1)).to.be.revertedWithCustomError(staking, "CannotRecoverThisToken");
    const stray = await ethers.deployContract("HimalToken", ["Stray", "STR", E(5), owner.address]);
    await stray.transfer(await staking.getAddress(), E(5));
    await expect(staking.recoverERC20(await stray.getAddress(), E(5))).to.emit(staking, "Recovered");
    expect(await stray.balanceOf(owner.address)).to.equal(E(5));
    await expect(staking.connect(ram).recoverERC20(await stray.getAddress(), 0)).to.be.revertedWithCustomError(staking, "OwnableUnauthorizedAccount");
  });

  it("input checks: zero stake, zero withdraw, withdrawing more than you staked", async function () {
    const { staking, ram } = await loadFixture(baseFixture);
    await expect(staking.connect(ram).stake(0)).to.be.revertedWithCustomError(staking, "ZeroAmount");
    await staking.connect(ram).stake(E(100));
    await expect(staking.connect(ram).withdraw(0)).to.be.revertedWithCustomError(staking, "ZeroAmount");
    await expect(staking.connect(ram).withdraw(E(101))).to.be.revertedWithCustomError(staking, "InsufficientBalance");
  });
});

describe("HimalStaking — rewards every second", function () {
  it("one staker for the whole week earns the whole 70,000 HRW", async function () {
    const { staking, hrw, ram } = await loadFixture(baseFixture);
    await staking.connect(ram).stake(E(1_000));
    await staking.notifyRewardAmount(E(70_000), WEEK);
    expect(await staking.rewardRate()).to.equal(E(70_000) / BigInt(WEEK)); // ~0.1157 HRW per second
    await time.increase(WEEK + 100);
    const earned = await staking.earned(ram.address);
    expect(earned).to.be.closeTo(E(70_000), DUST);
    expect(earned).to.be.lte(E(70_000));
    await expect(staking.connect(ram).getReward()).to.emit(staking, "RewardPaid").withArgs(ram.address, earned);
    expect(await hrw.balanceOf(ram.address)).to.equal(earned);
  });

  it("rewards are shared by amount AND time: Ram 1,000 all week, Sita 3,000 from halfway", async function () {
    const { staking, ram, sita } = await loadFixture(baseFixture);
    await staking.connect(ram).stake(E(1_000));
    const t0 = (await time.latest()) + 10;
    await at(t0);
    await staking.notifyRewardAmount(E(70_000), WEEK);
    await at(t0 + WEEK / 2);
    await staking.connect(sita).stake(E(3_000));
    await time.increaseTo(t0 + WEEK + 1);
    // First half: Ram alone gets 35,000. Second half: Ram 1/4, Sita 3/4 of 35,000.
    expect(await staking.earned(ram.address)).to.be.closeTo(E(35_000 + 8_750), DUST);
    expect(await staking.earned(sita.address)).to.be.closeTo(E(26_250), DUST);
  });

  it("rewards stop at the end of the period", async function () {
    const { staking, ram } = await loadFixture(baseFixture);
    await staking.connect(ram).stake(E(1_000));
    await staking.notifyRewardAmount(E(70_000), WEEK);
    await time.increase(WEEK);
    const atEnd = await staking.earned(ram.address);
    await time.increase(30 * DAY);
    expect(await staking.earned(ram.address)).to.equal(atEnd);
  });

  it("adding rewards mid-period carries the unpaid part over (nothing is lost)", async function () {
    const { staking, ram } = await loadFixture(baseFixture);
    await staking.connect(ram).stake(E(1_000));
    const t0 = (await time.latest()) + 10;
    await at(t0);
    await staking.notifyRewardAmount(E(70_000), WEEK);
    await at(t0 + WEEK / 2);
    await staking.notifyRewardAmount(E(35_000), WEEK); // 35,000 left + 35,000 new over 7 days
    await time.increaseTo(t0 + WEEK / 2 + WEEK + 1);
    expect(await staking.earned(ram.address)).to.be.closeTo(E(105_000), DUST);
  });

  it("exit() withdraws everything and claims; claiming twice pays nothing the second time", async function () {
    const { staking, him, hrw, ram } = await loadFixture(baseFixture);
    await staking.connect(ram).stake(E(1_000));
    await staking.notifyRewardAmount(E(70_000), WEEK);
    await time.increase(WEEK);
    await staking.connect(ram).exit();
    expect(await him.balanceOf(ram.address)).to.equal(E(10_000));
    const got = await hrw.balanceOf(ram.address);
    expect(got).to.be.closeTo(E(70_000), DUST);
    await staking.connect(ram).getReward();
    await staking.connect(ram).exit(); // nothing staked, nothing owed: no revert, no payment
    expect(await hrw.balanceOf(ram.address)).to.equal(got);
  });

  it("stakers can always withdraw, even if the owner walks away (renounces)", async function () {
    const { staking, him, ram } = await loadFixture(baseFixture);
    await staking.connect(ram).stake(E(1_000));
    await staking.notifyRewardAmount(E(70_000), WEEK);
    await staking.renounceOwnership();
    await time.increase(3 * DAY);
    await staking.connect(ram).withdraw(E(1_000));
    expect(await him.balanceOf(ram.address)).to.equal(E(10_000));
    expect(await staking.earned(ram.address)).to.be.gt(0);
  });
});

describe("Security focus: staking just before payout (F-02)", function () {
  it("NAIVE (lump-sum) pool: an attacker who stakes just before the deposit takes 90% of it", async function () {
    const { owner, ram, attacker, him, hrw } = await loadFixture(baseFixture);
    const naive = await ethers.deployContract("NaiveLumpStaking", [await him.getAddress(), await hrw.getAddress()]);
    const n = await naive.getAddress();
    await him.connect(ram).approve(n, ethers.MaxUint256);
    await him.connect(attacker).approve(n, ethers.MaxUint256);
    await hrw.approve(n, ethers.MaxUint256);
    await naive.connect(ram).stake(E(1_000)); // Ram staked for months
    await time.increase(30 * DAY);
    await naive.connect(attacker).stake(E(9_000)); // sees the deposit coming
    await naive.connect(owner).deposit(E(10_000));
    await naive.connect(attacker).getReward();
    await naive.connect(attacker).withdraw(E(9_000));
    expect(await hrw.balanceOf(attacker.address)).to.equal(E(9_000));
  });

  it("HIMAL pool: the same attacker staking just before the payout gets only ~1 second of rewards", async function () {
    const { staking, hrw, ram, attacker } = await loadFixture(baseFixture);
    await staking.connect(ram).stake(E(1_000));
    await time.increase(30 * DAY);
    await staking.connect(attacker).stake(E(9_000));
    await staking.notifyRewardAmount(E(70_000), WEEK);
    await staking.connect(attacker).exit(); // one second later
    const got = await hrw.balanceOf(attacker.address);
    expect(got).to.be.lt(E("0.2")); // 90% of one second ≈ 0.104 HRW, out of 70,000
    // Ram, who stays, still gets almost everything.
    await time.increase(WEEK);
    expect(await staking.earned(ram.address)).to.be.gt(E(69_999));
  });

  it("HIMAL pool: staking before the period but leaving early earns nothing extra later", async function () {
    const { staking, ram, attacker } = await loadFixture(baseFixture);
    await staking.connect(ram).stake(E(1_000));
    await staking.connect(attacker).stake(E(1_000));
    const t0 = (await time.latest()) + 10;
    await at(t0);
    await staking.notifyRewardAmount(E(70_000), WEEK);
    await at(t0 + DAY);
    await staking.connect(attacker).withdraw(E(1_000));
    const frozen = await staking.earned(attacker.address);
    expect(frozen).to.be.closeTo(E(5_000), DUST); // half of 1 day's 10,000
    await time.increase(WEEK);
    expect(await staking.earned(attacker.address)).to.equal(frozen);
    expect(await staking.earned(ram.address)).to.be.closeTo(E(65_000), DUST);
  });
});

describe("Security focus: reward rounding (F-01, F-03)", function () {
  async function sixDecimalFixture() {
    const base = await baseFixture();
    const usd = await ethers.deployContract("SixDecimalToken", [10n ** 12n]); // 1,000,000 USD6
    const classic = await ethers.deployContract("ClassicStaking", [await base.him.getAddress(), await usd.getAddress()]);
    const himal = await ethers.deployContract("HimalStaking", [await base.him.getAddress(), await usd.getAddress(), base.owner.address]);
    for (const p of [classic, himal]) {
      await usd.approve(await p.getAddress(), ethers.MaxUint256);
      await base.him.connect(base.ram).approve(await p.getAddress(), ethers.MaxUint256);
    }
    return { ...base, usd, classic, himal };
  }
  const USD = (n) => BigInt(Math.round(n * 1e6));

  it("CLASSIC: 1 USD6 over 30 days rounds to 0 per second, so stakers get 0 and it is stuck", async function () {
    const { classic, ram, usd } = await loadFixture(sixDecimalFixture);
    await classic.connect(ram).stake(E(1_000));
    await classic.notifyRewardAmount(USD(1), 30 * DAY);
    expect(await classic.rewardRate()).to.equal(0);
    await time.increase(31 * DAY);
    await classic.connect(ram).getReward();
    expect(await usd.balanceOf(ram.address)).to.equal(0);
  });

  it("CLASSIC: 100 USD6 over a year loses 5.39 USD6 (5.4%) to rounding", async function () {
    const { classic, ram, usd } = await loadFixture(sixDecimalFixture);
    await classic.connect(ram).stake(E(1_000));
    await classic.notifyRewardAmount(USD(100), 365 * DAY);
    expect(await classic.rewardRate()).to.equal(3); // 100,000,000 / 31,536,000 = 3.17 → 3
    await time.increase(366 * DAY);
    await classic.connect(ram).getReward();
    expect(await usd.balanceOf(ram.address)).to.equal(3n * BigInt(365 * DAY)); // 94.608 USD6
  });

  it("HIMAL: the same two rewards are paid out in full (scaled rate)", async function () {
    const { himal, ram, usd } = await loadFixture(sixDecimalFixture);
    await himal.connect(ram).stake(E(1_000));
    await himal.notifyRewardAmount(USD(1), 30 * DAY);
    await time.increase(31 * DAY);
    await himal.connect(ram).getReward();
    expect(await usd.balanceOf(ram.address)).to.be.gte(USD(1) - 1n);
    await himal.notifyRewardAmount(USD(100), 365 * DAY);
    await time.increase(366 * DAY);
    await himal.connect(ram).getReward();
    expect(await usd.balanceOf(ram.address)).to.be.gte(USD(101) - 2n); // at most 2 millionths lost
  });

  it("HIMAL: an attacker poking the pool 200 times cannot round anyone's rewards away (F-07)", async function () {
    const { himal, ram, sita, usd, him } = await loadFixture(sixDecimalFixture);
    await him.connect(sita).approve(await himal.getAddress(), ethers.MaxUint256);
    await himal.connect(ram).stake(E(5_000));
    await himal.connect(sita).stake(E(5_000));
    await himal.notifyRewardAmount(USD(10), 30 * DAY);
    for (let i = 0; i < 200; i++) {
      await time.increase(12_960 - 1); // every 3.6 hours for 30 days
      await himal.connect(sita).getReward(); // each call updates rewardPerToken
    }
    await time.increase(DAY);
    await himal.connect(ram).getReward();
    await himal.connect(sita).getReward();
    const r = await usd.balanceOf(ram.address);
    const s = await usd.balanceOf(sita.address);
    // Ram, who never touched the pool, still gets his full half (to within 1 millionth).
    expect(r).to.be.gte(USD(5) - 1n);
    // Each claim can only pay whole units, so the poker loses < 1 unit per claim of her OWN reward.
    expect(s).to.be.gte(USD(5) - 201n);
  });

  it("CLASSIC: rewards for days nobody was staked are stuck forever", async function () {
    const { classic, ram, usd } = await loadFixture(sixDecimalFixture);
    const t0 = (await time.latest()) + 10;
    await at(t0);
    await classic.notifyRewardAmount(USD(7_000), WEEK); // 1,000 USD6 per day
    await at(t0 + DAY);
    await classic.connect(ram).stake(E(1_000));
    await time.increaseTo(t0 + WEEK + 1);
    await classic.connect(ram).getReward();
    const got = await usd.balanceOf(ram.address);
    expect(got).to.be.closeTo(USD(6_000), USD(1));
    expect(await usd.balanceOf(await classic.getAddress())).to.be.closeTo(USD(1_000), USD(1)); // no way out
  });

  it("HIMAL: rewards for days nobody was staked roll into the next period", async function () {
    const { himal, ram, usd } = await loadFixture(sixDecimalFixture);
    const t0 = (await time.latest()) + 10;
    await at(t0);
    await himal.notifyRewardAmount(USD(7_000), WEEK);
    await at(t0 + DAY);
    await himal.connect(ram).stake(E(1_000));
    await time.increaseTo(t0 + WEEK + 1);
    expect(await himal.earned(ram.address)).to.be.closeTo(USD(6_000), 1n);
    expect((await himal.unallocatedScaled()) / 10n ** 36n).to.be.closeTo(USD(1_000), 1n);
    await himal.notifyRewardAmount(USD(7_000), WEEK); // 7,000 new + 1,000 kept
    expect(await himal.unallocatedScaled()).to.equal(0);
    await time.increase(WEEK + 1);
    await himal.connect(ram).getReward();
    expect(await usd.balanceOf(ram.address)).to.be.closeTo(USD(14_000), 2n);
  });
});

describe("Security: odd tokens and re-entry (F-04, F-06)", function () {
  it("a fee-on-transfer token: you are credited what arrived, so others' stakes stay safe", async function () {
    const { owner, ram, sita, hrw } = await loadFixture(baseFixture);
    const fee = await ethers.deployContract("FeeToken", [E(100_000)]);
    const pool = await ethers.deployContract("HimalStaking", [await fee.getAddress(), await hrw.getAddress(), owner.address]);
    const p = await pool.getAddress();
    for (const s of [ram, sita]) {
      await fee.transfer(s.address, E(1_000));
      await fee.connect(s).approve(p, ethers.MaxUint256);
    }
    await pool.connect(ram).stake(E(990)); // 1% fee: 980.1 arrives
    await pool.connect(sita).stake(E(990));
    expect(await pool.balanceOf(ram.address)).to.equal(E("980.1"));
    expect(await pool.totalStaked()).to.equal(await fee.balanceOf(p));
    await pool.connect(ram).withdraw(E("980.1"));
    await pool.connect(sita).withdraw(E("980.1")); // Sita is not short-changed
    expect(await fee.balanceOf(p)).to.equal(0);
  });

  it("a fee-on-transfer reward token: the rate is set from what really arrived", async function () {
    const { owner, him, ram } = await loadFixture(baseFixture);
    const fee = await ethers.deployContract("FeeToken", [E(100_000)]);
    const pool = await ethers.deployContract("HimalStaking", [await him.getAddress(), await fee.getAddress(), owner.address]);
    const p = await pool.getAddress();
    await fee.approve(p, ethers.MaxUint256);
    await him.connect(ram).approve(p, ethers.MaxUint256);
    await pool.connect(ram).stake(E(1_000));
    await pool.notifyRewardAmount(E(10_000), WEEK); // 9,900 arrives
    await time.increase(WEEK + 1);
    expect(await pool.earned(ram.address)).to.be.closeTo(E(9_900), DUST);
    await pool.connect(ram).getReward(); // and it can really be paid
  });

  it("a token with transfer hooks cannot be used to withdraw the same stake twice", async function () {
    const { owner, hrw } = await loadFixture(baseFixture);
    const hook = await ethers.deployContract("HookToken", [E(100_000)]);
    const pool = await ethers.deployContract("HimalStaking", [await hook.getAddress(), await hrw.getAddress(), owner.address]);
    const p = await pool.getAddress();
    const bad = await ethers.deployContract("ReentrantStaker", [p, await hook.getAddress()]);
    await hook.transfer(await bad.getAddress(), E(100));
    await bad.stake(E(100));
    await hook.approve(p, ethers.MaxUint256);
    await pool.stake(E(900)); // someone else's money in the pool
    await expect(bad.attack(E(100))).to.be.revertedWithCustomError(pool, "ReentrancyGuardReentrantCall");
    expect(await hook.balanceOf(p)).to.equal(E(1_000));
  });
});
