const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { E, fee, baseFixture, quoteRoundTrip, trade } = require("./helpers");

describe("FlashArbitrage (borrow → buy cheap → sell dear → repay)", function () {
  it("borrows 50,000 HUSD, buys HIM at 10, sells at 12, repays, and the owner keeps exactly the quoted profit", async function () {
    const f = await loadFixture(baseFixture);
    const amount = E(50_000);
    const q = await quoteRoundTrip(f, amount);
    expect(q.profit).to.be.gt(E(1_000));

    const t = await trade(f, q.profit);
    await expect(f.bot.connect(f.manish).run(amount, t))
      .to.emit(f.bot, "Arbitrage")
      .withArgs(f.A.husd, amount, fee(amount), q.profit);

    expect(await f.husd.balanceOf(f.manish.address)).to.equal(q.profit); // Manish started with 0 HUSD
    expect(await f.husd.balanceOf(await f.bot.getAddress())).to.equal(0n); // the bot keeps nothing
    expect(await f.him.balanceOf(await f.bot.getAddress())).to.equal(0n);
    expect(await f.lender.feesEarned(f.A.husd)).to.equal(fee(amount));
    // and the two prices moved towards each other
    const p = async (pair) => {
      const [r0, r1] = await pair.getReserves();
      return (await pair.token0()) === f.A.him ? (r1 * 1000n) / r0 : (r0 * 1000n) / r1;
    };
    expect(await p(f.himal.pair)).to.be.gt(10_000n);
    expect(await p(f.everest.pair)).to.be.lt(12_000n);
  });

  it("if the profit is below minProfit, everything reverts and nobody loses anything (F-06)", async function () {
    const f = await loadFixture(baseFixture);
    const amount = E(50_000);
    const q = await quoteRoundTrip(f, amount);
    await expect(f.bot.connect(f.manish).run(amount, await trade(f, q.profit + 1n)))
      .to.be.revertedWithCustomError(f.bot, "NotProfitable")
      .withArgs(q.profit, q.profit + 1n);
    expect(await f.husd.balanceOf(f.L)).to.equal(E(2_000_000));
  });

  it("a trade that would lose money reverts instead of paying the loan from someone's pocket (F-06)", async function () {
    const f = await loadFixture(baseFixture);
    // Way too big: buying 400,000 HUSD of HIM pushes the cheap price far above 12.
    const q = await quoteRoundTrip(f, E(400_000));
    expect(q.profit).to.be.lt(0n);
    await expect(f.bot.connect(f.manish).run(E(400_000), await trade(f, 0n)))
      .to.be.revertedWithCustomError(f.bot, "NotProfitable")
      .withArgs(0n, 0n);
  });

  it("only the owner can start it, and paths must form a loop", async function () {
    const f = await loadFixture(baseFixture);
    const t = await trade(f);
    await expect(f.bot.connect(f.attacker).run(E(1), t)).to.be.revertedWithCustomError(f.bot, "OwnableUnauthorizedAccount");
    await expect(f.bot.connect(f.manish).run(E(1), { ...t, sellPath: [f.A.him, f.A.him] }))
      .to.be.revertedWithCustomError(f.bot, "BadPath");
    await expect(f.bot.connect(f.manish).run(E(1), { ...t, sellPath: [f.A.husd, f.A.husd] }))
      .to.be.revertedWithCustomError(f.bot, "BadPath");
    await expect(f.bot.connect(f.manish).run(E(1), { ...t, buyPath: [f.A.husd] }))
      .to.be.revertedWithCustomError(f.bot, "BadPath");
  });

  describe("borrower-side checks (F-02)", function () {
    it("calling onFlashLoan directly (pretending to be the lender) is refused", async function () {
      const f = await loadFixture(baseFixture);
      const data = ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(address,address,address[],address[],uint256,uint256)"],
        [[f.himal.r, f.everest.r, [f.A.husd, f.A.him], [f.A.him, f.A.husd], 0, 0]],
      );
      const B = await f.bot.getAddress();
      await expect(f.bot.connect(f.attacker).onFlashLoan(B, f.A.husd, E(1), 0, data))
        .to.be.revertedWithCustomError(f.bot, "UntrustedLender")
        .withArgs(f.attacker.address);
    });

    it("a stranger who starts a flash loan FOR the bot is refused (initiator check)", async function () {
      const f = await loadFixture(baseFixture);
      const B = await f.bot.getAddress();
      await f.husd.transfer(B, E(1_000)); // say the bot holds some savings
      await expect(f.lender.connect(f.attacker).flashLoan(B, f.A.husd, E(1_000_000), "0x"))
        .to.be.revertedWithCustomError(f.bot, "UntrustedInitiator")
        .withArgs(f.attacker.address);
      expect(await f.husd.balanceOf(B)).to.equal(E(1_000));
    });

    it("WITHOUT the initiator check, a stranger drains a bot's savings through fees", async function () {
      const f = await loadFixture(baseFixture);
      const naive = await ethers.deployContract("NaiveBorrower", [f.L]);
      const N = await naive.getAddress();
      await f.husd.transfer(N, E(1_000)); // the bot's savings
      // Each loan of 1,000,000 HUSD costs the bot 900 HUSD in fees; the attacker pays only gas.
      await f.lender.connect(f.attacker).flashLoan(N, f.A.husd, E(1_000_000), "0x");
      expect(await f.husd.balanceOf(N)).to.equal(E(100));
      await f.lender.connect(f.attacker).flashLoan(N, f.A.husd, E(111_111), "0x");
      expect(await f.husd.balanceOf(N)).to.equal(E(100) - fee(E(111_111)));
      expect(await f.husd.balanceOf(f.attacker.address)).to.equal(0n);
    });
  });
});
