const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const fc = require("fast-check");

const HIM = (n) => ethers.parseEther(String(n));
const DAY = 24 * 60 * 60;
const DRIP = HIM(100); // tokens per claim
const BUDGET = HIM(1000); // tokens per UTC day for everyone together (= 10 claims)
const FUNDED = HIM(100000); // tokens the owner puts in the faucet

// Move the chain to the start of the next UTC day (plus `offset` seconds) for the next block.
async function startOfNextDay(offset = 0) {
  const now = await time.latest();
  const t = (Math.floor(now / DAY) + 1) * DAY + offset;
  await time.setNextBlockTimestamp(t);
  return t;
}

describe("HimalToken", function () {
  async function deployToken() {
    const [owner, alice] = await ethers.getSigners();
    const token = await ethers.deployContract("HimalToken");
    return { token, owner, alice };
  }

  it("has a name, symbol, 18 decimals and sends the whole fixed supply to the deployer", async function () {
    const { token, owner } = await loadFixture(deployToken);
    expect(await token.name()).to.equal("Himal Token");
    expect(await token.symbol()).to.equal("HIM");
    expect(await token.decimals()).to.equal(18n);
    expect(await token.totalSupply()).to.equal(HIM(1000000));
    expect(await token.balanceOf(owner.address)).to.equal(HIM(1000000));
  });

  it("has no mint function: nobody can ever create more tokens", async function () {
    const { token } = await loadFixture(deployToken);
    expect(token.interface.getFunction("mint", [])).to.equal(null);
    const fns = token.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
    expect(fns.some((n) => /mint/i.test(n))).to.equal(false);
  });

  it("transfers, approves and transferFrom like any ERC-20", async function () {
    const { token, owner, alice } = await loadFixture(deployToken);
    await expect(token.transfer(alice.address, HIM(5))).to.changeTokenBalances(token, [owner, alice], [-HIM(5), HIM(5)]);
    await token.connect(alice).approve(owner.address, HIM(2));
    await token.transferFrom(alice.address, owner.address, HIM(2));
    expect(await token.balanceOf(alice.address)).to.equal(HIM(3));
    await expect(token.transferFrom(alice.address, owner.address, 1n)).to.be.revertedWithCustomError(
      token,
      "ERC20InsufficientAllowance"
    );
  });
});

describe("Faucet", function () {
  async function deploy() {
    const signers = await ethers.getSigners();
    const [owner, alice, bob, eve] = signers;
    const token = await ethers.deployContract("HimalToken");
    const faucet = await ethers.deployContract("Faucet", [await token.getAddress(), DRIP, BUDGET]);
    await token.transfer(await faucet.getAddress(), FUNDED);
    return { token, faucet, owner, alice, bob, eve, signers };
  }

  describe("setup", function () {
    it("stores the token, drip, budget and owner", async function () {
      const { token, faucet, owner } = await loadFixture(deploy);
      expect(await faucet.token()).to.equal(await token.getAddress());
      expect(await faucet.dripAmount()).to.equal(DRIP);
      expect(await faucet.dailyBudget()).to.equal(BUDGET);
      expect(await faucet.owner()).to.equal(owner.address);
      expect(await faucet.COOLDOWN()).to.equal(BigInt(DAY));
    });

    it("rejects a zero token, a zero drip and a budget smaller than one drip", async function () {
      const { token } = await loadFixture(deploy);
      const F = await ethers.getContractFactory("Faucet");
      const t = await token.getAddress();
      await expect(F.deploy(ethers.ZeroAddress, DRIP, BUDGET)).to.be.revertedWithCustomError(F, "ZeroAddress");
      await expect(F.deploy(t, 0, BUDGET)).to.be.revertedWithCustomError(F, "BadLimits");
      await expect(F.deploy(t, DRIP, DRIP - 1n)).to.be.revertedWithCustomError(F, "BadLimits");
    });
  });

  describe("claim", function () {
    it("gives the drip to the caller and emits Claimed with the next allowed time", async function () {
      const { token, faucet, alice } = await loadFixture(deploy);
      const t = await startOfNextDay(100);
      await expect(faucet.connect(alice).claim())
        .to.emit(faucet, "Claimed")
        .withArgs(alice.address, DRIP, t + DAY);
      expect(await token.balanceOf(alice.address)).to.equal(DRIP);
      expect(await faucet.lastClaimAt(alice.address)).to.equal(BigInt(t));
      expect(await faucet.givenToday()).to.equal(DRIP);
    });

    it("an address waits a full 24 hours: 1 second early fails, exactly 24 hours works", async function () {
      const { faucet, alice } = await loadFixture(deploy);
      const t = await startOfNextDay(100);
      await faucet.connect(alice).claim();
      await expect(faucet.connect(alice).claim())
        .to.be.revertedWithCustomError(faucet, "TooSoon")
        .withArgs(t + DAY);
      await time.setNextBlockTimestamp(t + DAY - 1);
      await expect(faucet.connect(alice).claim()).to.be.revertedWithCustomError(faucet, "TooSoon");
      await time.setNextBlockTimestamp(t + DAY);
      await expect(faucet.connect(alice).claim()).to.emit(faucet, "Claimed");
    });

    it("a new UTC day does not reset an address's own 24-hour wait", async function () {
      const { faucet, alice } = await loadFixture(deploy);
      const t = await startOfNextDay(DAY - 60); // 23:59 UTC
      await faucet.connect(alice).claim();
      await time.setNextBlockTimestamp(t + 120); // 00:01 UTC the next day
      await expect(faucet.connect(alice).claim()).to.be.revertedWithCustomError(faucet, "TooSoon");
    });

    it("never gives a partial amount: an almost-empty faucet says FaucetEmpty", async function () {
      const { token, faucet, owner, alice } = await loadFixture(deploy);
      await faucet.withdraw(owner.address, FUNDED - DRIP + 1n); // leave 1 wei less than one drip
      await expect(faucet.connect(alice).claim()).to.be.revertedWithCustomError(faucet, "FaucetEmpty");
      expect(await token.balanceOf(alice.address)).to.equal(0n);
    });

    it("waitTime and remainingToday tell users what they can do", async function () {
      const { faucet, alice } = await loadFixture(deploy);
      await startOfNextDay(100);
      await faucet.connect(alice).claim();
      expect(await faucet.waitTime(alice.address)).to.equal(BigInt(DAY));
      expect(await faucet.remainingToday()).to.equal(BUDGET - DRIP);
      await time.increase(DAY);
      expect(await faucet.waitTime(alice.address)).to.equal(0n);
      expect(await faucet.remainingToday()).to.equal(BUDGET); // new day, full budget
    });
  });

  describe("daily budget", function () {
    it("10 different addresses claim, the 11th is told to come back tomorrow", async function () {
      const { faucet, signers } = await loadFixture(deploy);
      const t = await startOfNextDay(100);
      for (let i = 1; i <= 10; i++) await faucet.connect(signers[i]).claim();
      expect(await faucet.remainingToday()).to.equal(0n);
      const tomorrow = Math.floor(t / DAY + 1) * DAY;
      await expect(faucet.connect(signers[11]).claim())
        .to.be.revertedWithCustomError(faucet, "DailyBudgetUsed")
        .withArgs(tomorrow);
    });

    it("the budget starts again at 00:00 UTC", async function () {
      const { faucet, signers } = await loadFixture(deploy);
      const t = await startOfNextDay(100);
      for (let i = 1; i <= 10; i++) await faucet.connect(signers[i]).claim();
      await time.setNextBlockTimestamp(Math.floor(t / DAY + 1) * DAY - 1); // 23:59:59
      await expect(faucet.connect(signers[11]).claim()).to.be.revertedWithCustomError(faucet, "DailyBudgetUsed");
      await time.setNextBlockTimestamp(Math.floor(t / DAY + 1) * DAY); // 00:00:00
      await expect(faucet.connect(signers[11]).claim()).to.emit(faucet, "Claimed");
      expect(await faucet.givenToday()).to.equal(DRIP);
    });
  });

  describe("owner controls", function () {
    it("only the owner can change limits, pause, unpause and withdraw", async function () {
      const { faucet, eve } = await loadFixture(deploy);
      const err = "OwnableUnauthorizedAccount";
      await expect(faucet.connect(eve).setLimits(HIM(1), HIM(1))).to.be.revertedWithCustomError(faucet, err);
      await expect(faucet.connect(eve).pause()).to.be.revertedWithCustomError(faucet, err);
      await expect(faucet.connect(eve).unpause()).to.be.revertedWithCustomError(faucet, err);
      await expect(faucet.connect(eve).withdraw(eve.address, 1n)).to.be.revertedWithCustomError(faucet, err);
    });

    it("setLimits keeps the drip above zero and inside the budget", async function () {
      const { faucet } = await loadFixture(deploy);
      await expect(faucet.setLimits(HIM(50), HIM(500))).to.emit(faucet, "LimitsChanged").withArgs(HIM(50), HIM(500));
      await expect(faucet.setLimits(0, HIM(500))).to.be.revertedWithCustomError(faucet, "BadLimits");
      await expect(faucet.setLimits(HIM(600), HIM(500))).to.be.revertedWithCustomError(faucet, "BadLimits");
    });

    it("lowering the budget mid-day takes effect at once", async function () {
      const { faucet, signers } = await loadFixture(deploy);
      await startOfNextDay(100);
      for (let i = 1; i <= 5; i++) await faucet.connect(signers[i]).claim(); // 500 given
      await faucet.setLimits(DRIP, HIM(500));
      expect(await faucet.remainingToday()).to.equal(0n);
      await expect(faucet.connect(signers[6]).claim()).to.be.revertedWithCustomError(faucet, "DailyBudgetUsed");
    });

    it("pause stops every claim until unpause", async function () {
      const { faucet, alice } = await loadFixture(deploy);
      await faucet.pause();
      await expect(faucet.connect(alice).claim()).to.be.revertedWithCustomError(faucet, "EnforcedPause");
      await faucet.unpause();
      await expect(faucet.connect(alice).claim()).to.emit(faucet, "Claimed");
    });

    it("withdraw sends tokens out, never to the zero address", async function () {
      const { token, faucet, owner } = await loadFixture(deploy);
      await expect(faucet.withdraw(ethers.ZeroAddress, 1n)).to.be.revertedWithCustomError(faucet, "ZeroAddress");
      await expect(faucet.withdraw(owner.address, HIM(10)))
        .to.emit(faucet, "Withdrawn")
        .withArgs(owner.address, HIM(10));
      expect(await token.balanceOf(await faucet.getAddress())).to.equal(FUNDED - HIM(10));
    });

    it("ownership moves in two steps: the new owner must accept", async function () {
      const { faucet, owner, alice } = await loadFixture(deploy);
      await faucet.transferOwnership(alice.address);
      expect(await faucet.owner()).to.equal(owner.address);
      await faucet.connect(alice).acceptOwnership();
      expect(await faucet.owner()).to.equal(alice.address);
    });
  });

  describe("security: draining with many addresses", function () {
    it("one attacker with 50 brand-new contract addresses in one transaction gets only one day's budget", async function () {
      const { token, faucet, eve } = await loadFixture(deploy);
      const attacker = await ethers.deployContract("SybilAttacker");
      await startOfNextDay(100);
      await attacker.connect(eve).attack(await faucet.getAddress(), await token.getAddress(), 50);
      expect(await attacker.successes()).to.equal(10n);
      expect(await attacker.failures()).to.equal(40n);
      expect(await token.balanceOf(eve.address)).to.equal(BUDGET); // 1,000 HIM, not 5,000
      expect(await token.balanceOf(await faucet.getAddress())).to.equal(FUNDED - BUDGET);
    });

    it("attacking every day for 7 days takes at most 7 budgets; the faucet is never emptied", async function () {
      const { token, faucet, eve } = await loadFixture(deploy);
      const attacker = await ethers.deployContract("SybilAttacker");
      for (let d = 0; d < 7; d++) {
        await startOfNextDay(100);
        await attacker.connect(eve).attack(await faucet.getAddress(), await token.getAddress(), 30);
      }
      expect(await token.balanceOf(eve.address)).to.equal(BUDGET * 7n);
      expect(await token.balanceOf(await faucet.getAddress())).to.equal(FUNDED - BUDGET * 7n);
    });

    it("a contract cannot claim twice in one transaction", async function () {
      const { token, faucet } = await loadFixture(deploy);
      const dbl = await ethers.deployContract("DoubleClaimer");
      await expect(dbl.claimTwice(await faucet.getAddress())).to.be.revertedWithCustomError(faucet, "TooSoon");
      expect(await token.balanceOf(await dbl.getAddress())).to.equal(0n);
    });

    it("the owner can pause the faucet during an attack", async function () {
      const { token, faucet, eve } = await loadFixture(deploy);
      const attacker = await ethers.deployContract("SybilAttacker");
      await faucet.pause();
      await attacker.connect(eve).attack(await faucet.getAddress(), await token.getAddress(), 5);
      expect(await attacker.successes()).to.equal(0n);
      expect(await token.balanceOf(eve.address)).to.equal(0n);
    });
  });

  describe("fuzz: random claims by 6 addresses at random times", function () {
    it("matches a simple model; never more than the budget per day, never twice in 24 hours (100 random runs)", async function () {
      this.timeout(120000);
      const step = fc.record({
        who: fc.integer({ min: 1, max: 6 }),
        wait: fc.oneof(
          fc.integer({ min: 1, max: 600 }),
          fc.integer({ min: DAY - 5, max: DAY + 5 }),
          fc.integer({ min: 1, max: 2 * DAY })
        ),
      });
      await fc.assert(
        fc.asyncProperty(fc.array(step, { minLength: 5, maxLength: 25 }), async (steps) => {
          const { token, faucet, signers } = await loadFixture(deploy);
          // Small budget (3 claims a day) so the daily limit is hit often.
          await faucet.setLimits(DRIP, DRIP * 3n);
          const faucetAddr = await faucet.getAddress();
          const last = {}; // model: last claim time per address
          const givenPerDay = {}; // model: tokens given per UTC day
          let claimedTotal = 0n;
          let t = await time.latest();

          for (const s of steps) {
            t += s.wait;
            const who = signers[s.who];
            const day = Math.floor(t / DAY);
            const coolOk = last[who.address] === undefined || t >= last[who.address] + DAY;
            const budgetOk = (givenPerDay[day] || 0n) + DRIP <= DRIP * 3n;

            await time.setNextBlockTimestamp(t);
            if (coolOk && budgetOk) {
              await faucet.connect(who).claim();
              last[who.address] = t;
              givenPerDay[day] = (givenPerDay[day] || 0n) + DRIP;
              claimedTotal += DRIP;
            } else {
              await expect(faucet.connect(who).claim()).to.be.revertedWithCustomError(
                faucet,
                coolOk ? "DailyBudgetUsed" : "TooSoon"
              );
            }
            // Invariants after every step
            expect(await token.balanceOf(faucetAddr)).to.equal(FUNDED - claimedTotal); // nothing created or lost
            expect(await faucet.givenToday()).to.be.lte(DRIP * 3n); // never over budget
          }
          for (const v of Object.values(givenPerDay)) expect(v).to.be.lte(DRIP * 3n);
        }),
        { numRuns: 100 }
      );
    });
  });
});
