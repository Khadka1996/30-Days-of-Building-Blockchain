const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const fc = require("fast-check");

const DAY = 24 * 60 * 60;
const ONE_ETH = ethers.parseEther("1");

describe("PiggyBank", function () {
  async function deploy() {
    const [alice, bob, carol] = await ethers.getSigners();
    const piggy = await ethers.deployContract("PiggyBank");
    const now = await time.latest();
    return { piggy, alice, bob, carol, now };
  }

  async function bankOf(piggy, owner) {
    const [balance, unlockAt] = await piggy.getBank(owner);
    return { balance, unlockAt: Number(unlockAt) };
  }

  describe("depositing", function () {
    it("opens a bank with an unlock date and emits Deposited", async function () {
      const { piggy, alice, now } = await loadFixture(deploy);
      const unlockAt = now + 30 * DAY;
      await expect(piggy.deposit(unlockAt, { value: ONE_ETH }))
        .to.emit(piggy, "Deposited")
        .withArgs(alice.address, ONE_ETH, ONE_ETH, unlockAt);
      expect(await bankOf(piggy, alice.address)).to.deep.equal({ balance: ONE_ETH, unlockAt });
      expect(await piggy.totalLocked()).to.equal(ONE_ETH);
      expect(await ethers.provider.getBalance(await piggy.getAddress())).to.equal(ONE_ETH);
    });

    it("adds more money later with unlockAt = 0 and keeps the date", async function () {
      const { piggy, alice, now } = await loadFixture(deploy);
      const unlockAt = now + 30 * DAY;
      await piggy.deposit(unlockAt, { value: ONE_ETH });
      await piggy.deposit(0, { value: ONE_ETH });
      expect(await bankOf(piggy, alice.address)).to.deep.equal({ balance: 2n * ONE_ETH, unlockAt });
    });

    it("gives every user their own bank", async function () {
      const { piggy, alice, bob, now } = await loadFixture(deploy);
      await piggy.connect(alice).deposit(now + 10 * DAY, { value: ONE_ETH });
      await piggy.connect(bob).deposit(now + 20 * DAY, { value: 3n * ONE_ETH });
      expect((await bankOf(piggy, alice.address)).balance).to.equal(ONE_ETH);
      expect((await bankOf(piggy, bob.address)).balance).to.equal(3n * ONE_ETH);
      expect(await piggy.totalLocked()).to.equal(4n * ONE_ETH);
    });

    it("rejects a zero deposit", async function () {
      const { piggy, now } = await loadFixture(deploy);
      await expect(piggy.deposit(now + DAY, { value: 0 })).to.be.revertedWithCustomError(piggy, "ZeroDeposit");
    });

    it("rejects plain ETH sent without deposit()", async function () {
      const { piggy, alice } = await loadFixture(deploy);
      await expect(alice.sendTransaction({ to: await piggy.getAddress(), value: ONE_ETH })).to.be.reverted;
    });
  });

  describe("unlock date rules", function () {
    it("rejects an unlock date in the past or right now", async function () {
      const { piggy } = await loadFixture(deploy);
      const now = await time.latest();
      await expect(piggy.deposit(now - 1, { value: ONE_ETH })).to.be.revertedWithCustomError(piggy, "UnlockNotInFuture");
      await time.setNextBlockTimestamp(now + 10);
      await expect(piggy.deposit(now + 10, { value: ONE_ETH }))
        .to.be.revertedWithCustomError(piggy, "UnlockNotInFuture")
        .withArgs(now + 10, now + 10);
    });

    it("rejects locks longer than 10 years (e.g. a timestamp in milliseconds)", async function () {
      const { piggy } = await loadFixture(deploy);
      const max = Number(await piggy.MAX_LOCK_DURATION());
      const now = await time.latest();
      const millis = (now + DAY) * 1000;
      await time.setNextBlockTimestamp(now + 1);
      await expect(piggy.deposit(millis, { value: ONE_ETH })).to.be.revertedWithCustomError(piggy, "LockTooLong");
      await time.setNextBlockTimestamp(now + 2);
      await expect(piggy.deposit(now + 2 + max, { value: ONE_ETH })).to.not.be.reverted; // exactly 10 years is fine
    });

    it("a second deposit cannot change (or shorten) the date", async function () {
      const { piggy, now } = await loadFixture(deploy);
      await piggy.deposit(now + 30 * DAY, { value: ONE_ETH });
      await expect(piggy.deposit(now + DAY, { value: ONE_ETH }))
        .to.be.revertedWithCustomError(piggy, "LockAlreadySet")
        .withArgs(now + 30 * DAY);
    });

    it("extendLock moves the date later and emits LockExtended", async function () {
      const { piggy, alice, now } = await loadFixture(deploy);
      await piggy.deposit(now + 30 * DAY, { value: ONE_ETH });
      await expect(piggy.extendLock(now + 60 * DAY))
        .to.emit(piggy, "LockExtended")
        .withArgs(alice.address, now + 30 * DAY, now + 60 * DAY);
      expect((await bankOf(piggy, alice.address)).unlockAt).to.equal(now + 60 * DAY);
    });

    it("extendLock can never move the date earlier or keep it the same", async function () {
      const { piggy, now } = await loadFixture(deploy);
      await piggy.deposit(now + 30 * DAY, { value: ONE_ETH });
      await expect(piggy.extendLock(now + 29 * DAY)).to.be.revertedWithCustomError(piggy, "CannotShortenLock");
      await expect(piggy.extendLock(now + 30 * DAY)).to.be.revertedWithCustomError(piggy, "CannotShortenLock");
    });

    it("extendLock needs money in the bank and respects the 10-year limit", async function () {
      const { piggy, now } = await loadFixture(deploy);
      await expect(piggy.extendLock(now + DAY)).to.be.revertedWithCustomError(piggy, "NoActiveBank");
      await piggy.deposit(now + DAY, { value: ONE_ETH });
      await expect(piggy.extendLock(now + 11 * 365 * DAY)).to.be.revertedWithCustomError(piggy, "LockTooLong");
    });

    it("timeLeft counts down to 0", async function () {
      const { piggy, alice, now } = await loadFixture(deploy);
      await time.setNextBlockTimestamp(now + 1);
      await piggy.deposit(now + 1 + DAY, { value: ONE_ETH });
      expect(await piggy.timeLeft(alice.address)).to.equal(BigInt(DAY));
      await time.increaseTo(now + 1 + DAY);
      expect(await piggy.timeLeft(alice.address)).to.equal(0n);
    });
  });

  describe("withdrawing", function () {
    it("refuses one second before the unlock date, works exactly at it", async function () {
      const { piggy, alice, now } = await loadFixture(deploy);
      const unlockAt = now + 7 * DAY;
      await piggy.deposit(unlockAt, { value: ONE_ETH });

      await time.setNextBlockTimestamp(unlockAt - 1);
      await expect(piggy.withdraw())
        .to.be.revertedWithCustomError(piggy, "StillLocked")
        .withArgs(unlockAt, unlockAt - 1);

      await time.setNextBlockTimestamp(unlockAt);
      await expect(piggy.withdraw()).to.changeEtherBalances([alice, piggy], [ONE_ETH, -ONE_ETH]);
    });

    it("pays out everything, emits Withdrawn and resets the bank for reuse", async function () {
      const { piggy, alice, now } = await loadFixture(deploy);
      await piggy.deposit(now + DAY, { value: ONE_ETH });
      await piggy.deposit(0, { value: ONE_ETH });
      await time.increaseTo(now + DAY);
      await expect(piggy.withdraw()).to.emit(piggy, "Withdrawn").withArgs(alice.address, 2n * ONE_ETH);
      expect(await bankOf(piggy, alice.address)).to.deep.equal({ balance: 0n, unlockAt: 0 });
      expect(await piggy.totalLocked()).to.equal(0n);
      // Start a new saving goal with a new date.
      const later = (await time.latest()) + 5 * DAY;
      await expect(piggy.deposit(later, { value: ONE_ETH })).to.not.be.reverted;
    });

    it("cannot withdraw twice or from an empty bank", async function () {
      const { piggy, now } = await loadFixture(deploy);
      await expect(piggy.withdraw()).to.be.revertedWithCustomError(piggy, "NothingToWithdraw");
      await piggy.deposit(now + DAY, { value: ONE_ETH });
      await time.increaseTo(now + DAY);
      await piggy.withdraw();
      await expect(piggy.withdraw()).to.be.revertedWithCustomError(piggy, "NothingToWithdraw");
    });
  });

  describe("security", function () {
    it("Bob cannot take Alice's money, even after her unlock date", async function () {
      const { piggy, alice, bob, now } = await loadFixture(deploy);
      await piggy.connect(alice).deposit(now + DAY, { value: ONE_ETH });
      await time.increaseTo(now + DAY);
      await expect(piggy.connect(bob).withdraw()).to.be.revertedWithCustomError(piggy, "NothingToWithdraw");
      expect((await bankOf(piggy, alice.address)).balance).to.equal(ONE_ETH);
    });

    it("Bob cannot change Alice's unlock date", async function () {
      const { piggy, alice, bob, now } = await loadFixture(deploy);
      await piggy.connect(alice).deposit(now + 30 * DAY, { value: ONE_ETH });
      // Bob's calls only ever reach Bob's own (empty) bank.
      await expect(piggy.connect(bob).extendLock(now + 60 * DAY)).to.be.revertedWithCustomError(piggy, "NoActiveBank");
      expect((await bankOf(piggy, alice.address)).unlockAt).to.equal(now + 30 * DAY);
    });

    it("reentrancy: an attacker calling withdraw() again from receive() gets nothing extra", async function () {
      const { piggy, bob, now } = await loadFixture(deploy);
      // An honest saver so there is other people's money in the contract to steal.
      await piggy.connect(bob).deposit(now + 30 * DAY, { value: 5n * ONE_ETH });

      const attacker = await ethers.deployContract("ReentrancyAttacker", [await piggy.getAddress()]);
      await attacker.save(now + DAY, { value: ONE_ETH });
      await time.increaseTo(now + DAY);

      await expect(attacker.attack()).to.changeEtherBalances([attacker, piggy], [ONE_ETH, -ONE_ETH]);
      expect(await attacker.reentryAttempts()).to.equal(1n);
      expect(await attacker.reentrySucceeded()).to.equal(false);
      expect((await bankOf(piggy, bob.address)).balance).to.equal(5n * ONE_ETH);
      expect(await piggy.totalLocked()).to.equal(5n * ONE_ETH);
    });

    it("smart-contract wallets that need more than 2300 gas can withdraw", async function () {
      const { piggy, now } = await loadFixture(deploy);
      const wallet = await ethers.deployContract("SmartWallet", [await piggy.getAddress()]);
      await wallet.save(now + DAY, { value: ONE_ETH });
      await time.increaseTo(now + DAY);
      await wallet.take();
      expect(await wallet.received()).to.equal(ONE_ETH);
    });

    it("a failed payout reverts and the savings stay safe", async function () {
      const { piggy, now } = await loadFixture(deploy);
      const wallet = await ethers.deployContract("RejectingWallet", [await piggy.getAddress()]);
      await wallet.save(now + DAY, { value: ONE_ETH });
      await time.increaseTo(now + DAY);
      await expect(wallet.take()).to.be.revertedWithCustomError(piggy, "TransferFailed");
      expect((await bankOf(piggy, await wallet.getAddress())).balance).to.equal(ONE_ETH);
    });

    it("force-sent ETH (selfdestruct) does not change anyone's balance", async function () {
      const { piggy, alice, now } = await loadFixture(deploy);
      await piggy.deposit(now + DAY, { value: ONE_ETH });
      const factory = await ethers.getContractFactory("ForceSender");
      await factory.deploy(await piggy.getAddress(), { value: ONE_ETH });

      expect(await ethers.provider.getBalance(await piggy.getAddress())).to.equal(2n * ONE_ETH);
      expect(await piggy.totalLocked()).to.equal(ONE_ETH);
      await time.increaseTo(now + DAY);
      await expect(piggy.withdraw()).to.changeEtherBalance(alice, ONE_ETH); // exactly her 1 ETH
    });
  });

  describe("fuzz: random deposits, extensions, withdrawals and time jumps", function () {
    it("balances, totalLocked and ETH held always match a simple model (50 random runs)", async function () {
      this.timeout(120000);
      const { piggy, alice, bob } = await loadFixture(deploy);
      const users = [alice, bob];

      const op = fc.oneof(
        fc.record({ kind: fc.constant("deposit"), user: fc.nat(1), wei: fc.bigInt(1n, 10n ** 18n), days: fc.integer({ min: 0, max: 4000 }) }),
        fc.record({ kind: fc.constant("extend"), user: fc.nat(1), days: fc.integer({ min: -5, max: 4000 }) }),
        fc.record({ kind: fc.constant("withdraw"), user: fc.nat(1) }),
        fc.record({ kind: fc.constant("wait"), days: fc.integer({ min: 0, max: 40 }) })
      );

      await fc.assert(
        fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 12 }), async (ops) => {
          const fresh = await ethers.deployContract("PiggyBank");
          const model = [{ balance: 0n, unlockAt: 0 }, { balance: 0n, unlockAt: 0 }];
          const MAX = 10 * 365 * DAY;

          for (const o of ops) {
            const now = await time.latest();
            const next = now + 1; // timestamp of the next mined block
            await time.setNextBlockTimestamp(next);

            if (o.kind === "deposit") {
              const m = model[o.user];
              const fresh_ = m.balance === 0n;
              const unlockAt = fresh_ ? next + o.days * DAY : 0;
              const ok = !fresh_ || (unlockAt > next && unlockAt <= next + MAX);
              const tx = fresh.connect(users[o.user]).deposit(unlockAt, { value: o.wei });
              if (ok) {
                await tx;
                if (fresh_) m.unlockAt = unlockAt;
                m.balance += o.wei;
              } else {
                await expect(tx).to.be.reverted;
              }
            } else if (o.kind === "extend") {
              const m = model[o.user];
              const target = m.unlockAt + o.days * DAY;
              const ok = m.balance > 0n && target > m.unlockAt && target > next && target <= next + MAX;
              const tx = fresh.connect(users[o.user]).extendLock(target < 0 ? 0 : target);
              if (ok) {
                await tx;
                m.unlockAt = target;
              } else {
                await expect(tx).to.be.reverted;
              }
            } else if (o.kind === "withdraw") {
              const m = model[o.user];
              const ok = m.balance > 0n && next >= m.unlockAt;
              const tx = fresh.connect(users[o.user]).withdraw();
              if (ok) {
                await expect(tx).to.changeEtherBalance(users[o.user], m.balance);
                model[o.user] = { balance: 0n, unlockAt: 0 };
              } else {
                await expect(tx).to.be.reverted;
              }
            } else {
              await ethers.provider.send("evm_mine", []); // uses the timestamp set above
              if (o.days > 0) await time.increase(o.days * DAY);
            }
          }

          // Invariants: each bank matches the model, totalLocked is the sum,
          // and the contract holds exactly that much ETH.
          let sum = 0n;
          for (let u = 0; u < users.length; u++) {
            expect(await bankOf(fresh, users[u].address)).to.deep.equal(model[u]);
            sum += model[u].balance;
          }
          expect(await fresh.totalLocked()).to.equal(sum);
          expect(await ethers.provider.getBalance(await fresh.getAddress())).to.equal(sum);
        }),
        { numRuns: 50 }
      );
    });
  });
});
