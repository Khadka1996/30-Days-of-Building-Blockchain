const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { ETH, deploy } = require("./helpers");

const DailyLimit = 0, Guardian = 1;

describe("Day 27 — GuardedVault (the contract being watched)", () => {
  let env, vault, owner, guardian, users, attacker;
  beforeEach(async () => {
    env = await deploy();
    ({ vault, owner, guardian, users } = env);
    attacker = env.signers[15];
    await time.increase(86400); // the members' deposits were "yesterday": today's limit is the plain 50 ETH
  });

  describe("members", () => {
    it("deposits and withdraws their own ETH, with events the monitor can read", async () => {
      const [a] = users;
      await expect(vault.connect(a).deposit({ value: ETH(1) })).to.emit(vault, "Deposited").withArgs(a.address, ETH(1), ETH(101));
      const tx = vault.connect(a).withdraw(ETH(5));
      await expect(tx).to.emit(vault, "Withdrawn").withArgs(a.address, ETH(5), ETH(96));
      await expect(tx).to.changeEtherBalances([a, vault], [ETH(5), -ETH(5)]);
      expect(await vault.balanceOf(a.address)).to.equal(ETH(16));
      expect(await vault.totalDeposits()).to.equal(ETH(96));
    });

    it("can't withdraw more than their balance, zero, or someone else's ETH", async () => {
      const [a] = users;
      await expect(vault.connect(a).withdraw(ETH(21))).to.be.revertedWithCustomError(vault, "InsufficientBalance");
      await expect(vault.connect(a).withdraw(0)).to.be.revertedWithCustomError(vault, "ZeroAmount");
      await expect(vault.connect(attacker).withdraw(1)).to.be.revertedWithCustomError(vault, "InsufficientBalance");
      await expect(vault.connect(a).deposit()).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("blocks re-entrancy: withdrawing again inside the ETH transfer fails", async () => {
      const bad = await ethers.deployContract("ReentrantMember", [await vault.getAddress()]);
      await bad.join({ value: ETH(2) });
      await expect(bad.attack(ETH(1))).to.be.revertedWithCustomError(vault, "TransferFailed");
      expect(await vault.balanceOf(await bad.getAddress())).to.equal(ETH(2));
    });

    it("refuses plain ETH transfers (no receive): every deposit goes through deposit() and its event", async () => {
      await expect(users[0].sendTransaction({ to: await vault.getAddress(), value: ETH(1) })).to.be.reverted;
    });
  });

  describe("daily outflow limit (circuit breaker)", () => {
    it("caps total withdrawals per day across ALL members, then resets the next day", async () => {
      const [a, b, c] = users;
      await vault.connect(a).withdraw(ETH(20));
      await vault.connect(b).withdraw(ETH(20));
      expect(await vault.leftToday()).to.equal(ETH(10));
      await expect(vault.connect(c).withdraw(ETH(11))).to.be.revertedWithCustomError(vault, "DailyLimitExceeded").withArgs(ETH(10), ETH(11));
      await vault.connect(c).withdraw(ETH(10));
      expect(await vault.leftToday()).to.equal(0);
      await time.increase(86400);
      expect(await vault.leftToday()).to.equal(ETH(50));
      await vault.connect(c).withdraw(ETH(10));
    });

    it("F-1: one rich member can't use up the daily limit to lock everyone else out", async () => {
      const [whale, member] = users;
      await vault.connect(whale).deposit({ value: ETH(40) }); // 60 ETH, deposited "yesterday"
      await time.increase(86400);
      await vault.connect(whale).withdraw(ETH(50)); // uses the whole 50 ETH limit…
      await vault.connect(whale).deposit({ value: ETH(50) }); // …and puts it straight back (costs only gas)
      expect(await vault.leftToday()).to.equal(ETH(50)); // net outflow today is 0
      await vault.connect(member).withdraw(ETH(10)); // others can still get their money
      // a real drain (no ETH coming back) is still capped
      await vault.connect(whale).withdraw(ETH(40));
      await expect(vault.connect(whale).withdraw(ETH(1))).to.be.revertedWithCustomError(vault, "DailyLimitExceeded");
    });

    it("splitting a drain over many addresses doesn't get around it", async () => {
      // 5 members × 11 ETH = 55 > 50: the 5th is refused
      for (const u of users.slice(0, 4)) await vault.connect(u).withdraw(ETH(11));
      await expect(vault.connect(users[4]).withdraw(ETH(11))).to.be.revertedWithCustomError(vault, "DailyLimitExceeded");
    });
  });

  describe("admin changes are timelocked", () => {
    it("a new limit only applies after DELAY, and the event says when", async () => {
      const tx = await vault.queueDailyLimit(ETH(80));
      const eta = (await ethers.provider.getBlock(tx.blockNumber)).timestamp + 86400;
      await expect(tx).to.emit(vault, "ChangeQueued").withArgs(DailyLimit, ETH(80), eta, owner.address);
      await expect(vault.execute(DailyLimit)).to.be.revertedWithCustomError(vault, "TooEarly");
      await time.increaseTo(eta - 2);
      await expect(vault.execute(DailyLimit)).to.be.revertedWithCustomError(vault, "TooEarly");
      await time.increaseTo(eta);
      await expect(vault.execute(DailyLimit)).to.emit(vault, "ChangeExecuted").withArgs(DailyLimit, ETH(50), ETH(80), owner.address);
      expect(await vault.dailyLimit()).to.equal(ETH(80));
      await expect(vault.execute(DailyLimit)).to.be.revertedWithCustomError(vault, "NothingQueued");
    });

    it("a queued change can't be silently replaced by a second one", async () => {
      await vault.queueDailyLimit(ETH(60));
      await expect(vault.queueDailyLimit(ETH(9000))).to.be.revertedWithCustomError(vault, "AlreadyQueued");
    });

    it("guardian change works the same way", async () => {
      await vault.queueGuardian(attacker.address);
      await time.increase(86400);
      await vault.execute(Guardian);
      expect(await vault.guardian()).to.equal(attacker.address);
    });

    it("only the owner can queue or execute; bad values are refused", async () => {
      await expect(vault.connect(guardian).queueDailyLimit(ETH(1))).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
      await expect(vault.connect(attacker).queueGuardian(attacker.address)).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
      await vault.queueDailyLimit(ETH(60));
      await time.increase(86400);
      await expect(vault.connect(attacker).execute(DailyLimit)).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
      await expect(vault.queueGuardian(ethers.ZeroAddress)).to.be.revertedWithCustomError(vault, "BadValue");
      await vault.cancel(DailyLimit);
      await expect(vault.queueDailyLimit(0)).to.be.revertedWithCustomError(vault, "BadValue");
      await expect(vault.queueDailyLimit(ETH(10001))).to.be.revertedWithCustomError(vault, "BadValue");
      await expect(ethers.deployContract("GuardedVault", [ethers.ZeroAddress, ETH(1)])).to.be.revertedWithCustomError(vault, "BadValue");
    });

    it("the guardian can cancel a queued change (e.g. after an alert); outsiders can't", async () => {
      await vault.queueDailyLimit(ETH(9000));
      await expect(vault.connect(attacker).cancel(DailyLimit)).to.be.revertedWithCustomError(vault, "NotGuardianOrOwner");
      await expect(vault.connect(guardian).cancel(DailyLimit)).to.emit(vault, "ChangeCancelled").withArgs(DailyLimit, ETH(9000), guardian.address);
      await time.increase(86400);
      await expect(vault.execute(DailyLimit)).to.be.revertedWithCustomError(vault, "NothingQueued");
      await expect(vault.connect(guardian).cancel(DailyLimit)).to.be.revertedWithCustomError(vault, "NothingQueued");
    });

    it("ownership moves in two steps (the new owner must accept)", async () => {
      await expect(vault.transferOwnership(attacker.address)).to.emit(vault, "OwnershipTransferStarted");
      expect(await vault.owner()).to.equal(owner.address);
      await vault.connect(attacker).acceptOwnership();
      expect(await vault.owner()).to.equal(attacker.address);
    });
  });

  describe("emergency pause", () => {
    it("guardian or owner can pause; it stops deposits and withdrawals; outsiders can't", async () => {
      await expect(vault.connect(attacker).pause()).to.be.revertedWithCustomError(vault, "NotGuardianOrOwner");
      await expect(vault.connect(guardian).pause()).to.emit(vault, "Paused").withArgs(guardian.address);
      await expect(vault.connect(users[0]).withdraw(1)).to.be.revertedWithCustomError(vault, "EnforcedPause");
      await expect(vault.connect(users[0]).deposit({ value: 1 })).to.be.revertedWithCustomError(vault, "EnforcedPause");
    });

    it("only the owner can unpause: a stolen guardian key can stop the vault, never reopen or drain it", async () => {
      await vault.connect(guardian).pause();
      await expect(vault.connect(guardian).unpause()).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
      await expect(vault.unpause()).to.emit(vault, "Unpaused").withArgs(owner.address);
      await vault.connect(users[0]).withdraw(ETH(1));
    });
  });
});
