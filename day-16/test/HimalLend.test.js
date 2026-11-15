const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { E, P, DAY, YEAR, baseFixture, borrowedFixture, wait } = require("./helpers");

const WAD = 10n ** 18n;
const pct = (x) => (BigInt(Math.round(x * 100)) * WAD) / 10_000n; // 5.5 -> 0.055e18

describe("HimalLend — setup and access control", function () {
  it("rejects zero addresses and using the same token for lending and collateral", async function () {
    const { husd, him, feed, owner } = await loadFixture(baseFixture);
    const F = await ethers.getContractFactory("HimalLend");
    const [a, c, p] = [await husd.getAddress(), await him.getAddress(), await feed.getAddress()];
    await expect(F.deploy(ethers.ZeroAddress, c, p, owner.address)).to.be.revertedWithCustomError(F, "ZeroAddress");
    await expect(F.deploy(a, ethers.ZeroAddress, p, owner.address)).to.be.revertedWithCustomError(F, "ZeroAddress");
    await expect(F.deploy(a, c, ethers.ZeroAddress, owner.address)).to.be.revertedWithCustomError(F, "ZeroAddress");
    await expect(F.deploy(a, a, p, owner.address)).to.be.revertedWithCustomError(F, "SameToken");
    const usd6 = await ethers.deployContract("SixDecimalToken", [E(1)]);
    await expect(F.deploy(await usd6.getAddress(), c, p, owner.address)).to.be.revertedWithCustomError(F, "DecimalsMismatch");
  });

  it("only the reporter can post prices and only the owner can take reserves, never more than the reserves", async function () {
    const { lend, feed, ram, owner } = await loadFixture(borrowedFixture);
    await expect(feed.connect(ram).setPrice(P(100))).to.be.revertedWithCustomError(feed, "OwnableUnauthorizedAccount");
    await wait({ feed }, YEAR, 10);
    await expect(lend.connect(ram).withdrawReserves(ram.address, 1)).to.be.revertedWithCustomError(lend, "OwnableUnauthorizedAccount");
    await lend.accrue();
    const r = await lend.reserves();
    expect(r).to.be.gt(0n);
    await expect(lend.withdrawReserves(owner.address, r + E(1))).to.be.revertedWithCustomError(lend, "ZeroAmount");
    const assetsBefore = await lend.totalAssets();
    await lend.withdrawReserves(owner.address, r / 2n);
    // Taking reserves does not change what lenders own (only a few seconds of new interest).
    expect(await lend.totalAssets()).to.be.closeTo(assetsBefore, E(0.01));
  });

  it("zero amounts are refused everywhere", async function () {
    const { lend, ram } = await loadFixture(borrowedFixture);
    for (const fn of ["deposit", "redeem", "depositCollateral", "withdrawCollateral", "borrow"]) {
      await expect(lend.connect(ram)[fn](0)).to.be.revertedWithCustomError(lend, "ZeroAmount");
    }
    await expect(lend.repay(ram.address, 1)).to.be.revertedWithCustomError(lend, "ZeroAmount"); // Ram has no debt
    await expect(lend.liquidate(ram.address, 0)).to.be.revertedWithCustomError(lend, "ZeroAmount");
  });
});

describe("HimalLend — lending and borrowing", function () {
  it("lenders get their HUSD back; cash that is lent out cannot be redeemed until it is repaid", async function () {
    const { lend, husd, ram, sita, hari } = await loadFixture(borrowedFixture);
    // 20,000 lent, 7,000 borrowed: 13,000 cash. Ram can take his 10,000, Sita then only 3,000.
    await lend.connect(ram).redeem(await lend.sharesOf(ram.address));
    const sitaShares = await lend.sharesOf(sita.address);
    await expect(lend.connect(sita).redeem(sitaShares)).to.be.revertedWithCustomError(lend, "InsufficientCash");
    await lend.connect(hari).repay(hari.address, ethers.MaxUint256);
    const before = await husd.balanceOf(sita.address);
    await lend.connect(sita).redeem(sitaShares);
    expect((await husd.balanceOf(sita.address)) - before).to.be.gte(E(10_000) - 1n);
  });

  it("borrow up to 75% of the collateral value, not 1 wei more", async function () {
    const { lend, ram, mina } = await loadFixture(baseFixture);
    await lend.connect(ram).deposit(E(10_000));
    // Mina: 100 HIM at $10 = $1,000 -> max 750 HUSD.
    await lend.connect(mina).depositCollateral(E(100));
    await expect(lend.connect(mina).borrow(E(750) + 1n)).to.be.revertedWithCustomError(lend, "Unhealthy");
    await lend.connect(mina).borrow(E(750));
    expect(await lend.debtOf(mina.address)).to.equal(E(750));
  });

  it("you cannot take out collateral that is still needed to cover your debt", async function () {
    const { lend, hari } = await loadFixture(borrowedFixture);
    // Hari owes 7,000 against $10,000: he can take out at most 66.66 HIM ($9,333 x 75% = 7,000).
    await expect(lend.connect(hari).withdrawCollateral(E(67))).to.be.revertedWithCustomError(lend, "Unhealthy");
    await lend.connect(hari).withdrawCollateral(E(66));
  });

  it("with no debt you can always take your collateral back, even if the price feed is stale", async function () {
    const { lend, him, mina } = await loadFixture(baseFixture);
    await lend.connect(mina).depositCollateral(E(500));
    await time.increase(2 * DAY); // no price update for 2 days
    const before = await him.balanceOf(mina.address);
    await lend.connect(mina).withdrawCollateral(E(500));
    expect((await him.balanceOf(mina.address)) - before).to.equal(E(500));
    await expect(lend.connect(mina).withdrawCollateral(1)).to.be.revertedWithCustomError(lend, "InsufficientCollateral");
  });

  it("debt rounds up: borrowing 1 wei 50 times creates at least 50 wei of debt (F-05)", async function () {
    const f = await loadFixture(borrowedFixture);
    const { lend, mina } = f;
    await wait(f, 37 * DAY, 10); // index now > 1.0
    await lend.accrue();
    expect(await lend.borrowIndex()).to.be.gt(WAD);
    await lend.connect(mina).depositCollateral(E(1));
    for (let i = 0; i < 50; i++) await lend.connect(mina).borrow(1);
    expect(await lend.debtOf(mina.address)).to.be.gte(50n);
  });

  it("donating HUSD straight to the pool does not change the share price", async function () {
    const { lend, husd, pool, attacker } = await loadFixture(borrowedFixture);
    const before = await lend.previewRedeem(E(1));
    await husd.connect(attacker).transfer(pool, E(50_000));
    expect(await lend.previewRedeem(E(1))).to.equal(before);
  });

  it("refuses fee-on-transfer tokens instead of booking money that never arrived", async function () {
    const { him, feed, owner } = await loadFixture(baseFixture);
    const fee = await ethers.deployContract("FeeToken", [E(1_000_000)]);
    const lend = await ethers.deployContract("HimalLend", [await fee.getAddress(), await him.getAddress(), await feed.getAddress(), owner.address]);
    await fee.approve(await lend.getAddress(), ethers.MaxUint256);
    await expect(lend.deposit(E(100))).to.be.revertedWithCustomError(lend, "TokenMismatch");
  });
});

describe("HimalLend — interest", function () {
  it("the kinked rate model: 2% empty, 10% at 80% used, then steep up to 100%", async function () {
    const { lend } = await loadFixture(baseFixture);
    expect(await lend.borrowRatePerYear(0)).to.equal(pct(2));
    expect(await lend.borrowRatePerYear(pct(40))).to.equal(pct(6));
    expect(await lend.borrowRatePerYear(pct(80))).to.equal(pct(10));
    expect(await lend.borrowRatePerYear(pct(90))).to.equal(pct(55));
    expect(await lend.borrowRatePerYear(WAD)).to.equal(WAD);
  });

  it("a year of interest: the borrower pays it, lenders get 90%, reserves 10%, and it all adds up", async function () {
    const f = await loadFixture(borrowedFixture);
    const { lend, husd, ram, sita, hari } = f;
    expect(await lend.utilization()).to.equal(pct(35));
    expect(await lend.borrowRatePerYear(pct(35))).to.equal(pct(5.5));
    const assets0 = await lend.totalAssets();
    await wait(f, YEAR, 10);
    await lend.accrue();
    const debt = await lend.debtOf(hari.address);
    const interest = debt - E(7_000);
    // About 5.5% of 7,000 = 385 (a little more: interest also runs for the few seconds of setup).
    expect(interest).to.be.gt(E(385)).and.lt(E(400));
    expect(await lend.reserves()).to.be.closeTo(interest / 10n, 2n);
    expect((await lend.totalAssets()) - assets0).to.be.closeTo(interest - interest / 10n, 2n);
    // Hari repays everything; both lenders leave with principal + their half of 90% of the interest.
    await lend.connect(hari).repay(hari.address, ethers.MaxUint256);
    expect(await lend.debtSharesOf(hari.address)).to.equal(0n);
    for (const l of [ram, sita]) {
      const b = await husd.balanceOf(l.address);
      await lend.connect(l).redeem(await lend.sharesOf(l.address));
      expect((await husd.balanceOf(l.address)) - b).to.be.closeTo(E(10_000) + (interest * 9n) / 20n, E(0.001));
    }
    // What is left is exactly the reserves (plus at most a few wei of rounding, kept by the pool).
    expect(await lend.totalCash()).to.be.gte(await lend.reserves());
    expect((await lend.totalCash()) - (await lend.reserves())).to.be.lt(10n);
  });

  it("every action settles interest first, so nobody can repay or borrow at an old index", async function () {
    const f = await loadFixture(borrowedFixture);
    await wait(f, YEAR, 10);
    const idx = await f.lend.borrowIndex();
    await f.lend.connect(f.hari).repay(f.hari.address, E(1));
    expect(await f.lend.borrowIndex()).to.be.gt(idx);
  });
});

describe("HimalLend — the price oracle", function () {
  it("refuses a price older than 1 hour, zero or negative, but still lets people repay and lend (F-02)", async function () {
    const f = await loadFixture(borrowedFixture);
    const { lend, feed, hari, mina, gita, ram } = f;
    await lend.connect(mina).depositCollateral(E(100));
    await time.increase(3601);
    await expect(lend.connect(mina).borrow(E(1))).to.be.revertedWithCustomError(lend, "StalePrice");
    await expect(lend.connect(hari).withdrawCollateral(E(1))).to.be.revertedWithCustomError(lend, "StalePrice");
    await expect(lend.connect(gita).liquidate(hari.address, E(1))).to.be.revertedWithCustomError(lend, "StalePrice");
    await lend.connect(hari).repay(hari.address, E(100)); // repaying never needs a price
    await lend.connect(ram).deposit(E(100));
    await feed.setPrice(0);
    await expect(lend.connect(mina).borrow(E(1))).to.be.revertedWithCustomError(lend, "BadPrice");
    await feed.setPrice(-5);
    await expect(lend.connect(mina).borrow(E(1))).to.be.revertedWithCustomError(lend, "BadPrice");
    await feed.setPrice(P(10));
    await lend.connect(mina).borrow(E(1));
  });

  it("NAIVE pool priced by a swap pool's spot price: one big trade lets an attacker borrow everything (F-01)", async function () {
    const { husd, him, owner, attacker } = await loadFixture(baseFixture);
    const r = await spotAttack({ husd, him, owner, attacker });
    // The attacker pumped HIM from $1 to ~$16, borrowed all 50,000 HUSD against 4,200 HIM and sold the rest back.
    expect(r.pumpedPrice).to.be.gt(P(15));
    expect(r.borrowed).to.equal(E(50_000));
    expect(r.profit).to.be.gt(E(40_000));
    expect(r.collateralRealValue).to.equal(E(4_200)); // the pool is left with 50,000 of debt it can never collect
  });

  it("HIMAL pool, same trade: the feed price does not move, so the attacker can borrow only 75% of the real value", async function () {
    const { husd, him, owner, attacker } = await loadFixture(baseFixture);
    const feed = await ethers.deployContract("HimalPriceFeed", [P(1), owner.address]);
    const lend = await ethers.deployContract("HimalLend", [await husd.getAddress(), await him.getAddress(), await feed.getAddress(), owner.address]);
    const r = await spotAttack({ husd, him, owner, attacker, lend });
    expect(r.pumpedPrice).to.be.gt(P(15)); // the swap pool was pumped just the same...
    expect(r.borrowBigReverted).to.equal(true); // ...but borrowing 50,000 reverts with Unhealthy
    expect(r.maxBorrow).to.equal(E(3_150)); // 4,200 HIM x $1 x 75%
  });
});

describe("HimalLend — liquidation and bad debt", function () {
  it("a healthy borrower cannot be liquidated", async function () {
    const { lend, hari, gita } = await loadFixture(borrowedFixture);
    // $10,000 x 80% = $8,000 > 7,000 debt.
    await expect(lend.connect(gita).liquidate(hari.address, E(1_000))).to.be.revertedWithCustomError(lend, "NotLiquidatable");
  });

  it("price falls to $8.50: a liquidator repays at most half the debt and gets 5% extra collateral", async function () {
    const f = await loadFixture(borrowedFixture);
    const { lend, him, feed, hari, gita } = f;
    await feed.setPrice(P(8.5)); // $8,500 x 80% = $6,800 < 7,000: liquidatable
    expect(await lend.healthFactor(hari.address)).to.be.lt(WAD);
    const debt = await lend.debtOf(hari.address);
    const himBefore = await him.balanceOf(gita.address);
    const tx = await lend.connect(gita).liquidate(hari.address, E(1_000_000)); // asks for far too much
    await expect(tx).to.emit(lend, "Liquidate");
    const got = (await him.balanceOf(gita.address)) - himBefore;
    const paid = debt - (await lend.debtOf(hari.address));
    expect(paid).to.be.closeTo(debt / 2n, E(0.001)); // close factor 50% (plus 1 second of interest)
    // Gita paid ~3,500 HUSD and got $3,500 x 1.05 = $3,675 of HIM at $8.50 = 432.35 HIM.
    expect(got).to.be.closeTo((paid * 105n * 10n ** 8n) / (100n * P(8.5)), E(0.001));
    expect(await lend.healthFactor(hari.address)).to.be.gt(WAD); // healthy again...
    await expect(lend.connect(gita).liquidate(hari.address, 1)).to.be.revertedWithCustomError(lend, "NotLiquidatable"); // ...so no second bite
  });

  it("price crashes to $6: the whole debt is closed, the loss is written off, reserves first, then lenders equally (F-03)", async function () {
    const f = await loadFixture(borrowedFixture);
    const { lend, husd, him, feed, ram, sita, hari, gita } = f;
    await wait(f, YEAR, 10); // a year of interest builds some reserves
    await feed.setPrice(P(6)); // $6,000 of collateral for ~7,390 of debt: underwater
    await lend.accrue();
    const debt = await lend.debtOf(hari.address);
    const reserves = await lend.reserves();
    const assetsBefore = await lend.totalAssets();

    const tx = await lend.connect(gita).liquidate(hari.address, ethers.MaxUint256);
    await expect(tx).to.emit(lend, "BadDebtWrittenOff");
    expect(await lend.collateralOf(hari.address)).to.equal(0n);
    expect(await lend.debtSharesOf(hari.address)).to.equal(0n);
    expect(await him.balanceOf(gita.address)).to.equal(E(100_000) + E(1_000)); // all 1,000 HIM

    // Gita paid what the collateral is worth minus her 5% bonus: 6,000 / 1.05 = 5,714.29.
    const repaid = (E(6_000) * 100n + 104n) / 105n;
    const loss = debt - repaid;
    expect(await lend.totalBadDebt()).to.be.closeTo(loss, E(0.001)); // (1 second of interest)
    expect(await lend.reserves()).to.equal(0n); // reserves took the first part of the loss
    expect(assetsBefore - (await lend.totalAssets())).to.be.closeTo(loss - reserves, E(0.001));

    // Both lenders lose the same amount, and the last one out is NOT left with an empty pool.
    const got = [];
    for (const l of [ram, sita]) {
      const b = await husd.balanceOf(l.address);
      await lend.connect(l).redeem(await lend.sharesOf(l.address));
      got.push((await husd.balanceOf(l.address)) - b);
    }
    expect(got[0]).to.be.closeTo(got[1], 2n);
    expect(await lend.totalCash()).to.be.lt(10n);
  });

  it("liquidating an underwater loan in small steps still ends with no debt left hiding in the books", async function () {
    const f = await loadFixture(borrowedFixture);
    const { lend, feed, hari, gita } = f;
    await feed.setPrice(P(6));
    // Liquidating in small steps still ends with collateral 0 and the leftover debt written off, never left behind.
    for (let i = 0; i < 3 && (await lend.collateralOf(hari.address)) > 0n; i++) {
      await lend.connect(gita).liquidate(hari.address, E(2_000));
    }
    if ((await lend.collateralOf(hari.address)) > 0n) await lend.connect(gita).liquidate(hari.address, ethers.MaxUint256);
    expect(await lend.collateralOf(hari.address)).to.equal(0n);
    expect(await lend.debtOf(hari.address)).to.equal(0n);
    expect(await lend.totalDebt()).to.equal(0n); // no phantom debt inflating the share price
  });
});

// --- shared attack script for the two spot-price tests ---
async function spotAttack({ husd, him, owner, attacker, lend }) {
  const pair = await ethers.deployContract("MiniPair", [await him.getAddress(), await husd.getAddress()]);
  const pairAddr = await pair.getAddress();
  await him.approve(pairAddr, ethers.MaxUint256);
  await husd.approve(pairAddr, ethers.MaxUint256);
  await pair.addLiquidity(E(10_000), E(10_000)); // 1 HIM = $1
  await him.connect(attacker).approve(pairAddr, ethers.MaxUint256);
  await husd.connect(attacker).approve(pairAddr, ethers.MaxUint256);

  let target;
  if (lend) {
    target = lend;
    await husd.approve(await lend.getAddress(), ethers.MaxUint256);
    await lend.deposit(E(50_000));
    await him.connect(attacker).approve(await lend.getAddress(), ethers.MaxUint256);
  } else {
    target = await ethers.deployContract("NaiveSpotLending", [await husd.getAddress(), await him.getAddress(), pairAddr]);
    await husd.approve(await target.getAddress(), ethers.MaxUint256);
    await target.fund(E(50_000));
    await him.connect(attacker).approve(await target.getAddress(), ethers.MaxUint256);
  }

  // The attacker starts with 30,000 HUSD and no HIM.
  await him.connect(attacker).transfer(owner.address, await him.balanceOf(attacker.address));
  const husd0 = await husd.balanceOf(attacker.address);
  const startHusd = E(30_000);
  await husd.connect(attacker).transfer(owner.address, husd0 - startHusd);

  const priceBefore = await pair.spotPrice();
  // 1. Buy HIM with 30,000 HUSD: the spot price jumps.
  await pair.connect(attacker).swap(await husd.getAddress(), startHusd);
  const pumpedPrice = await pair.spotPrice();
  // 2. Lock 4,200 HIM and try to borrow 50,000 HUSD.
  await target.connect(attacker).depositCollateral(E(4_200));
  let borrowed = 0n;
  let borrowBigReverted = false;
  try {
    await target.connect(attacker).borrow(E(50_000));
    borrowed = E(50_000);
  } catch (e) {
    borrowBigReverted = e.message.includes("Unhealthy");
  }
  const maxBorrow = lend ? await lend.maxBorrow(attacker.address) : 0n;
  // 3. Sell the rest of the HIM back.
  await pair.connect(attacker).swap(await him.getAddress(), await him.balanceOf(attacker.address));
  const profit = (await husd.balanceOf(attacker.address)) - startHusd;
  const collateralRealValue = (E(4_200) * priceBefore) / 10n ** 8n; // at the fair $1 price
  return { pumpedPrice, borrowed, borrowBigReverted, maxBorrow, profit, collateralRealValue };
}

module.exports = { spotAttack };
