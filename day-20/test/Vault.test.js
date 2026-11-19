const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { E, UNLOCK, baseFixture } = require("./helpers");

const fixture = () => baseFixture();
const fastFixture = () => baseFixture(1); // a vault whose profit unlocks after 1 second (no real lock)

// Ram deposits 1,000 and Sita 3,000; the vault invests 90% in HimalSavings.
async function twoDepositors(f) {
  await f.vault.connect(f.ram).deposit(E(1000), f.ram.address);
  await f.vault.connect(f.sita).deposit(E(3000), f.sita.address);
  await f.vault.invest();
}

describe("Day 20 — YieldVault (ERC-4626)", function () {
  describe("deposits, shares and withdrawals", function () {
    it("gives 1,000,000 shares per HUSD to the first depositor (6 virtual decimals) and pays back exactly", async function () {
      const { vault, husd, ram } = await loadFixture(fixture);
      expect(await vault.decimals()).to.equal(24);
      await expect(vault.connect(ram).deposit(E(1000), ram.address))
        .to.emit(vault, "Deposit")
        .withArgs(ram.address, ram.address, E(1000), E(1000) * 10n ** 6n);
      expect(await vault.totalAssets()).to.equal(E(1000));
      expect(await vault.idle()).to.equal(E(1000));
      const before = await husd.balanceOf(ram.address);
      await vault.connect(ram).redeem(await vault.balanceOf(ram.address), ram.address, ram.address);
      expect((await husd.balanceOf(ram.address)) - before).to.equal(E(1000));
      expect(await vault.totalAssets()).to.equal(0);
    });

    it("invest() keeps 10% as cash, and withdrawals bring the rest back from the strategy", async function () {
      const f = await loadFixture(fixture);
      const { vault, savings, sita } = f;
      await twoDepositors(f);
      expect(await vault.idle()).to.equal(E(400));
      expect(await savings.totalAssets()).to.equal(E(3600));
      await expect(vault.invest()).to.be.revertedWithCustomError(vault, "NothingToInvest");
      // Sita takes out 2,000: 400 from cash, 1,600 from the strategy.
      await vault.connect(sita).withdraw(E(2000), sita.address, sita.address);
      expect(await vault.idle()).to.equal(0);
      expect(await savings.totalAssets()).to.equal(E(2000));
      expect(await vault.strategyAssets()).to.equal(E(2000));
      expect(await vault.totalAssets()).to.equal(E(2000));
    });

    it("mint and withdraw round in the vault's favour (ERC-4626 preview rules)", async function () {
      const f = await loadFixture(fixture);
      const { vault, savings, borrower } = f;
      await twoDepositors(f);
      await savings.connect(borrower).payInterest(E(333));
      await vault.harvest();
      await time.increase(UNLOCK);
      const shares = 10n ** 24n + 7n;
      expect(await vault.previewMint(shares)).to.be.gt(await vault.convertToAssets(shares));
      const assets = E(1) + 3n;
      expect(await vault.previewWithdraw(assets)).to.be.gt(await vault.convertToShares(assets));
    });

    it("refuses zero deposits and zero withdrawals", async function () {
      const { vault, ram } = await loadFixture(fixture);
      await expect(vault.connect(ram).deposit(0, ram.address)).to.be.revertedWithCustomError(vault, "ZeroAmount");
      await expect(vault.connect(ram).mint(0, ram.address)).to.be.revertedWithCustomError(vault, "ZeroAmount");
      await vault.connect(ram).deposit(E(1), ram.address);
      await expect(vault.connect(ram).redeem(0, ram.address, ram.address)).to.be.revertedWithCustomError(vault, "ZeroAmount");
      await expect(vault.connect(ram).withdraw(0, ram.address, ram.address)).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("lets an approved spender redeem for someone else, and nobody else", async function () {
      const { vault, ram, sita, attacker } = await loadFixture(fixture);
      await vault.connect(ram).deposit(E(100), ram.address);
      const shares = await vault.balanceOf(ram.address);
      await expect(vault.connect(attacker).redeem(shares, attacker.address, ram.address)).to.be.revertedWithCustomError(
        vault,
        "ERC20InsufficientAllowance",
      );
      await vault.connect(ram).approve(sita.address, shares);
      await vault.connect(sita).redeem(shares, sita.address, ram.address);
      expect(await vault.balanceOf(ram.address)).to.equal(0);
    });
  });

  describe("sharing the profit", function () {
    it("shares 400 HUSD of interest 1 : 3, unlocked over 6 hours", async function () {
      const f = await loadFixture(fixture);
      const { vault, savings, husd, ram, sita, borrower } = f;
      await twoDepositors(f);
      await savings.connect(borrower).payInterest(E(400));
      expect(await vault.totalAssets()).to.equal(E(4000)); // not counted before a harvest
      await expect(vault.harvest()).to.emit(vault, "Harvested").withArgs(E(400), 0, E(400));
      expect(await vault.totalAssets()).to.equal(E(4000)); // harvest itself does not move the price
      await time.increase(UNLOCK / 2 - 1); // half-way (the next block adds 1 second)
      await ethers.provider.send("evm_mine", []);
      expect(await vault.totalAssets()).to.equal(E(4200));
      await time.increase(UNLOCK);
      expect(await vault.totalAssets()).to.equal(E(4400));

      const r0 = await husd.balanceOf(ram.address);
      const s0 = await husd.balanceOf(sita.address);
      await vault.connect(ram).redeem(await vault.balanceOf(ram.address), ram.address, ram.address);
      await vault.connect(sita).redeem(await vault.balanceOf(sita.address), sita.address, sita.address);
      const ramGot = (await husd.balanceOf(ram.address)) - r0;
      const sitaGot = (await husd.balanceOf(sita.address)) - s0;
      // Exactly 1,100 and 3,300 minus the dust the virtual shares keep (less than 0.000001 HUSD).
      expect(ramGot).to.be.closeTo(E(1100), 10n ** 12n);
      expect(sitaGot).to.be.closeTo(E(3300), 10n ** 12n);
      expect(ramGot).to.be.lte(E(1100));
      expect(sitaGot).to.be.lte(E(3300));
    });

    it("a loss counts at once and first eats the profit that is still locked", async function () {
      const f = await loadFixture(fixture);
      const { vault, savings, deployer, borrower } = f;
      await twoDepositors(f);
      await savings.connect(borrower).payInterest(E(400));
      await vault.harvest();
      // A borrower defaults on 500 while 400 of profit is still locked: shareholders lose only 100.
      await savings.simulateLoss(E(500), deployer.address);
      const before = await vault.totalAssets();
      expect(before).to.be.closeTo(E(3900), E(1)); // a few seconds of profit had unlocked
      await expect(vault.harvest()).to.emit(vault, "Harvested");
      expect(await vault.totalAssets()).to.equal(before); // harvesting a loss does not move the price either
      expect(await vault.lockedProfit()).to.equal(0);
    });

    it("harvest with nothing new does not restart the unlock clock", async function () {
      const f = await loadFixture(fixture);
      const { vault, savings, borrower } = f;
      await twoDepositors(f);
      await savings.connect(borrower).payInterest(E(400));
      await vault.harvest();
      const start = await vault.lastHarvest();
      await time.increase(3600);
      await vault.harvest();
      expect(await vault.lastHarvest()).to.equal(start);
    });
    it("UNLOCK GRIEFING: 1-wei interest + harvest every 10 minutes cannot hold the profit back (F-05)", async function () {
      const f = await loadFixture(fixture);
      const { vault, savings, attacker, borrower } = f;
      await twoDepositors(f);
      await savings.connect(borrower).payInterest(E(400));
      await vault.harvest();
      const start = await time.latest();
      for (let i = 0; i < 34; i++) {
        await time.increase(600);
        await savings.connect(attacker).payInterest(1n);
        await vault.harvest();
      }
      await time.increaseTo(start + UNLOCK + 60);
      await ethers.provider.send("evm_mine", []);
      // The real 400 HUSD has unlocked on time; only the attacker's few wei are still locked.
      expect(await vault.lockedProfit()).to.be.lt(100n);
      expect(await vault.totalAssets()).to.be.gte(E(4400));
    });
  });

  describe("attacks", function () {
    it("INFLATION ATTACK on the naive vault: 1 wei + a 1,000 HUSD donation steals Ram's 1,000 HUSD", async function () {
      const { naive, husd, ram, attacker } = await loadFixture(fixture);
      const a0 = await husd.balanceOf(attacker.address);
      await naive.connect(attacker).deposit(1n); // 1 share for 1 wei
      await husd.connect(attacker).transfer(await naive.getAddress(), E(1000)); // 1 share is now worth 1,000 HUSD
      await naive.connect(ram).deposit(E(1000)); // 1,000 × 1 ÷ (1,000 + 1 wei) = 0 shares
      expect(await naive.balanceOf(ram.address)).to.equal(0);
      await naive.connect(attacker).redeem(1n);
      expect((await husd.balanceOf(attacker.address)) - a0).to.equal(E(1000)); // Ram's whole deposit
      expect(await husd.balanceOf(await naive.getAddress())).to.equal(0);
    });

    it("the same attack on YieldVault: the donation is ignored and Ram gets fair shares (F-01)", async function () {
      const { vault, husd, ram, attacker } = await loadFixture(fixture);
      await vault.connect(attacker).deposit(1n, attacker.address);
      await husd.connect(attacker).transfer(await vault.getAddress(), E(1000));
      expect(await vault.totalAssets()).to.equal(1n); // the vault counts its own cash
      await vault.connect(ram).deposit(E(1000), ram.address);
      expect(await vault.previewRedeem(await vault.balanceOf(ram.address))).to.equal(E(1000));
      const a0 = await husd.balanceOf(attacker.address);
      await vault.connect(attacker).redeem(await vault.balanceOf(attacker.address), attacker.address, attacker.address);
      expect((await husd.balanceOf(attacker.address)) - a0).to.equal(1n); // the 1,000 HUSD donation is lost
    });

    it("donating through the strategy instead: virtual shares make the attacker lose ~half, Ram < 0.001 HUSD (F-01)", async function () {
      const { vault, savings, husd, ram, attacker } = await loadFixture(fixture);
      const a0 = await husd.balanceOf(attacker.address);
      await vault.connect(attacker).deposit(1n, attacker.address);
      await savings.connect(attacker).payInterest(E(1000)); // counted as profit after a harvest
      await vault.harvest();
      await time.increase(UNLOCK); // the attacker must wait 6 hours for it to unlock
      expect(await vault.totalAssets()).to.equal(E(1000) + 1n);
      await vault.connect(ram).deposit(E(1000), ram.address);
      const ramValue = await vault.previewRedeem(await vault.balanceOf(ram.address));
      expect(E(1000) - ramValue).to.be.lt(E("0.001"));
      await vault.connect(attacker).redeem(await vault.balanceOf(attacker.address), attacker.address, attacker.address);
      const lost = a0 - (await husd.balanceOf(attacker.address));
      expect(lost).to.be.gt(E(499));
    });

    it("PROFIT SNIPING: without a lock Hari takes 96% of the interest in 1 block; with the 6-hour lock almost nothing (F-02)", async function () {
      for (const [fx, check] of [
        [fastFixture, (gain) => expect(gain).to.be.gt(E(380))],
        [fixture, (gain) => expect(gain).to.be.lt(E("0.02"))],
      ]) {
        const f = await loadFixture(fx);
        const { vault, savings, husd, hari, borrower } = f;
        await twoDepositors(f);
        await savings.connect(borrower).payInterest(E(400)); // interest is waiting to be harvested
        const h0 = await husd.balanceOf(hari.address);
        await vault.connect(hari).deposit(E(100_000), hari.address); // jump in just before
        await vault.harvest();
        await vault.connect(hari).redeem(await vault.balanceOf(hari.address), hari.address, hari.address); // and out
        check((await husd.balanceOf(hari.address)) - h0);
      }
    });

    it("cannot exit at the old price after a loss: losses count before anyone harvests (F-03)", async function () {
      const f = await loadFixture(fixture);
      const { vault, savings, husd, deployer, ram } = f;
      await twoDepositors(f);
      await savings.simulateLoss(E(1000), deployer.address); // 25% of the vault is gone
      expect(await vault.totalAssets()).to.equal(E(3000));
      const r0 = await husd.balanceOf(ram.address);
      await vault.connect(ram).redeem(await vault.balanceOf(ram.address), ram.address, ram.address);
      expect((await husd.balanceOf(ram.address)) - r0).to.be.closeTo(E(750), 10n ** 12n); // a fair 25% loss, not 0%
    });

    it("depositWithMin / redeemWithMin protect against a price that moved (F-04)", async function () {
      const f = await loadFixture(fixture);
      const { vault, savings, deployer, ram } = f;
      await twoDepositors(f);
      const quote = await vault.previewDeposit(E(1000));
      await savings.simulateLoss(E(400), deployer.address); // the price moves before Ram's transaction lands
      // Ram now gets MORE shares, which is fine; check the other direction with redeem:
      await vault.connect(ram).depositWithMin(E(1000), ram.address, quote);
      const shares = await vault.balanceOf(ram.address);
      const expected = await vault.previewRedeem(shares);
      await savings.simulateLoss(E(400), deployer.address);
      await expect(vault.connect(ram).redeemWithMin(shares, ram.address, ram.address, expected))
        .to.be.revertedWithCustomError(vault, "TooFewAssets");
      await expect(vault.connect(ram).depositWithMin(E(1000), ram.address, quote * 2n)).to.be.revertedWithCustomError(
        vault,
        "TooFewShares",
      );
    });
  });

  describe("set-up and access", function () {
    it("only the vault can move money in and out of the strategy, and the vault is set once", async function () {
      const { savings, vault, attacker, deployer } = await loadFixture(fixture);
      await expect(savings.connect(attacker).deposit(E(1))).to.be.revertedWithCustomError(savings, "OnlyVault");
      await expect(savings.connect(attacker).withdraw(E(1))).to.be.revertedWithCustomError(savings, "OnlyVault");
      await expect(savings.connect(attacker).simulateLoss(0, attacker.address)).to.be.revertedWithCustomError(savings, "OnlyDeployer");
      await expect(savings.connect(attacker).setVault(attacker.address)).to.be.revertedWithCustomError(savings, "OnlyDeployer");
      await expect(savings.connect(deployer).setVault(attacker.address)).to.be.revertedWithCustomError(savings, "VaultAlreadySet");
      expect(await savings.vault()).to.equal(await vault.getAddress());
    });

    it("refuses a strategy for another token and unlock times of 0 or over 30 days", async function () {
      const { husd, savings } = await loadFixture(fixture);
      const other = await ethers.deployContract("HimalToken", ["Other", "OTH", E(1), (await ethers.getSigners())[0].address]);
      const V = await ethers.getContractFactory("YieldVault");
      await expect(V.deploy(await other.getAddress(), await savings.getAddress(), UNLOCK)).to.be.revertedWithCustomError(V, "WrongAsset");
      await expect(V.deploy(await husd.getAddress(), await savings.getAddress(), 0)).to.be.revertedWithCustomError(V, "BadUnlockTime");
      await expect(V.deploy(await husd.getAddress(), await savings.getAddress(), 31 * 86400)).to.be.revertedWithCustomError(V, "BadUnlockTime");
      await expect(V.deploy(await husd.getAddress(), ethers.ZeroAddress, UNLOCK)).to.be.revertedWithCustomError(V, "ZeroAddress");
    });
  });
});
