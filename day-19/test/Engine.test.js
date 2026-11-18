const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { E, USD, baseFixture, seizeFor } = require("./helpers");

const fixture = () => loadFixture(baseFixture);

describe("Everest Dollar (EUSD)", function () {
  it("is created by the engine, and only the engine can mint or burn", async function () {
    const { engine, eusd, ram } = await fixture();
    expect(await eusd.engine()).to.equal(await engine.getAddress());
    expect(await eusd.symbol()).to.equal("EUSD");
    await expect(eusd.connect(ram).mint(ram.address, E(1))).to.be.revertedWithCustomError(eusd, "OnlyEngine");
    await expect(eusd.connect(ram).burn(ram.address, 0)).to.be.revertedWithCustomError(eusd, "OnlyEngine");
  });
});

describe("DollarEngine: vaults", function () {
  it("mints up to 150%: 10 ETH at $2,000 backs at most 13,333.33 EUSD", async function () {
    const { engine, eusd, ram } = await fixture();
    await engine.connect(ram).deposit({ value: E(10) });
    await expect(engine.connect(ram).mint(E("13333.34"))).to.be.revertedWithCustomError(engine, "Unhealthy");
    await engine.connect(ram).mint(E("13333.33"));
    expect(await eusd.balanceOf(ram.address)).to.equal(E("13333.33"));
    expect(await engine.collateralRatio(ram.address)).to.be.gte(E("1.5"));
    expect(await engine.isLiquidatable(ram.address)).to.equal(false);
    expect(await engine.totalDebt()).to.equal(E("13333.33"));
  });

  it("depositAndMint, repay and withdraw: a full round trip gives every wei back", async function () {
    const { engine, eusd, ram } = await fixture();
    await engine.connect(ram).depositAndMint(E(5000), { value: E(10) });
    expect(await engine.collateralRatio(ram.address)).to.equal(E(4)); // $20,000 / 5,000 = 400%
    await expect(engine.connect(ram).withdraw(E("6.26"))).to.be.revertedWithCustomError(engine, "Unhealthy");
    await engine.connect(ram).withdraw(E("6.24")); // 3.76 ETH = $7,520 ≥ 150% of 5,000 (6.25 would be exactly 150%)
    await engine.connect(ram).repay(E(5000));
    expect(await eusd.totalSupply()).to.equal(0);
    await expect(engine.connect(ram).withdraw(E("3.76"))).to.changeEtherBalances([engine, ram], [E("-3.76"), E("3.76")]);
    const v = await engine.vaults(ram.address);
    expect(v.collateral).to.equal(0);
    expect(v.debt).to.equal(0);
  });

  it("refuses dust debt below 100 EUSD, zero amounts, too much repay or withdraw, and plain ETH", async function () {
    const { engine, ram } = await fixture();
    await engine.connect(ram).deposit({ value: E(1) });
    await expect(engine.connect(ram).mint(E(99))).to.be.revertedWithCustomError(engine, "DustDebt");
    await engine.connect(ram).mint(E(500));
    await expect(engine.connect(ram).repay(E(450))).to.be.revertedWithCustomError(engine, "DustDebt");
    await expect(engine.connect(ram).repay(E(501))).to.be.revertedWithCustomError(engine, "NotEnough");
    await expect(engine.connect(ram).withdraw(E(2))).to.be.revertedWithCustomError(engine, "NotEnough");
    await expect(engine.connect(ram).mint(0)).to.be.revertedWithCustomError(engine, "ZeroAmount");
    await expect(engine.connect(ram).repay(0)).to.be.revertedWithCustomError(engine, "ZeroAmount");
    await expect(engine.connect(ram).withdraw(0)).to.be.revertedWithCustomError(engine, "ZeroAmount");
    await expect(engine.connect(ram).deposit()).to.be.revertedWithCustomError(engine, "ZeroAmount");
    await expect(engine.connect(ram).liquidate(ram.address, 0)).to.be.revertedWithCustomError(engine, "ZeroAmount");
    await expect(ram.sendTransaction({ to: await engine.getAddress(), value: E(1) })).to.be.revertedWithCustomError(engine, "UseDeposit");
  });

  it("stops at the debt ceiling", async function () {
    const { F, ram } = await fixture();
    const small = await ethers.deployContract("DollarEngine", [F, E(1000)]);
    await small.connect(ram).depositAndMint(E(1000), { value: E(10) });
    await expect(small.connect(ram).mint(E(1))).to.be.revertedWithCustomError(small, "CeilingReached");
  });
});

describe("DollarEngine: liquidation", function () {
  async function ramAt12k() {
    const f = await fixture();
    await f.engine.connect(f.ram).depositAndMint(E(12_000), { value: E(10) }); // 166.7% at $2,000
    await f.engine.connect(f.gita).depositAndMint(E(100_000), { value: E(1000) }); // Gita, the liquidator
    return f;
  }

  it("a healthy vault cannot be liquidated", async function () {
    const { engine, gita, ram, feed } = await ramAt12k();
    await feed.setPrice(USD(1800)); // exactly 150%
    await expect(engine.connect(gita).liquidate(ram.address, E(100))).to.be.revertedWithCustomError(engine, "StillHealthy");
  });

  it("ETH falls to $1,700: Gita repays half (6,000 EUSD) and gets that value + 10% in ETH", async function () {
    const { engine, eusd, gita, ram, feed } = await ramAt12k();
    await feed.setPrice(USD(1700)); // 10 ETH = $17,000 → 141.7%
    expect(await engine.isLiquidatable(ram.address)).to.equal(true);
    await expect(engine.connect(gita).liquidate(ram.address, E("6000.01"))).to.be.revertedWithCustomError(engine, "RepayTooLarge");
    const seized = seizeFor(E(6000), E(1700)); // 3.882352941176470588 ETH = $6,600
    await expect(engine.connect(gita).liquidate(ram.address, E(6000))).to.changeEtherBalances([engine, gita], [-seized, seized]);
    const v = await engine.vaults(ram.address);
    expect(v.debt).to.equal(E(6000));
    expect(v.collateral).to.equal(E(10) - seized);
    expect(await engine.isLiquidatable(ram.address)).to.equal(false); // back to 173%
    expect(await eusd.balanceOf(gita.address)).to.equal(E(94_000));
  });

  it("ETH crashes to $1,000 (83%): the vault closes in one go, and what the ETH cannot cover is written off openly", async function () {
    const { engine, eusd, gita, ram, feed } = await ramAt12k();
    await feed.setPrice(USD(1000)); // 10 ETH = $10,000 against 12,000 EUSD
    const needed = (E(10_000) * 10n ** 18n + E("1.1") - 1n) / E("1.1"); // 9,090.909… EUSD, rounded up
    await expect(engine.connect(gita).liquidate(ram.address, E(6000))).to.be.revertedWithCustomError(engine, "RepayTooSmall");
    await expect(engine.connect(gita).liquidate(ram.address, E(12_001))).to.be.revertedWithCustomError(engine, "RepayTooLarge");
    await expect(engine.connect(gita).liquidate(ram.address, needed)).to.changeEtherBalances([engine, gita], [E(-10), E(10)]);
    const v = await engine.vaults(ram.address);
    expect(v.collateral).to.equal(0); // no wei of dust left to keep a broken vault "alive"
    expect(v.debt).to.equal(0);
    expect(await engine.badDebt()).to.equal(E(12_000) - needed); // 2,909.09 EUSD with no ETH behind it
    expect(await engine.totalDebt()).to.equal(E(100_000)); // only Gita's vault is left
    expect(await eusd.totalSupply()).to.equal((await engine.totalDebt()) + (await engine.badDebt()));
  });

  it("at 104% the liquidator must repay the WHOLE debt: no avoidable bad debt (F-05)", async function () {
    const { engine, gita, ram, feed } = await ramAt12k();
    await feed.setPrice(USD(1250)); // 10 ETH = $12,500 against 12,000 EUSD: solvent, but under 110%
    // Repaying ~11,364 and taking all the ETH with a full 10% bonus would leave 636 EUSD of bad debt
    await expect(engine.connect(gita).liquidate(ram.address, E("11363.64"))).to.be.revertedWithCustomError(engine, "RepayTooSmall");
    await expect(engine.connect(gita).liquidate(ram.address, E(12_000))).to.changeEtherBalances([engine, gita], [E(-10), E(10)]);
    expect(await engine.badDebt()).to.equal(0); // the bonus shrank to $500 (4.2%) instead
    expect((await engine.vaults(ram.address)).debt).to.equal(0);
  });

  it("a liquidator that refuses ETH only blocks itself; the vault owner cannot block liquidation", async function () {
    const { engine, eusd, gita, ram, feed } = await ramAt12k();
    const bot = await ethers.deployContract("ReentrantVault", [await engine.getAddress()]);
    await eusd.connect(gita).transfer(await bot.getAddress(), E(1000));
    await bot.setMode(3); // Reject
    await feed.setPrice(USD(1700));
    await expect(bot.liquidate(ram.address, E(1000))).to.be.revertedWithCustomError(engine, "EthTransferFailed");
    await engine.connect(gita).liquidate(ram.address, E(1000));
    expect((await engine.vaults(ram.address)).debt).to.equal(E(11_000));
  });

  it("re-entering the engine while receiving ETH is blocked (withdraw, mint, liquidate)", async function () {
    const { engine, eusd, gita, ram, feed } = await ramAt12k();
    const bot = await ethers.deployContract("ReentrantVault", [await engine.getAddress()]);
    await bot.deposit({ value: E(10) });
    await bot.mint(E(1000));
    await bot.setMode(1); // WithdrawAgain
    await expect(bot.withdraw(E(1))).to.be.revertedWithCustomError(engine, "EthTransferFailed");
    await bot.setMode(2); // MintAgain
    await expect(bot.withdraw(E(1))).to.be.revertedWithCustomError(engine, "EthTransferFailed");
    await eusd.connect(gita).transfer(await bot.getAddress(), E(1000));
    await feed.setPrice(USD(1700));
    await expect(bot.liquidate(ram.address, E(1000))).to.be.revertedWithCustomError(engine, "EthTransferFailed");
    expect(await bot.reentered()).to.equal(false);
    expect((await engine.vaults(await bot.getAddress())).collateral).to.equal(E(10));
  });
});

describe("DollarEngine: price safety (stale prices and depeg)", function () {
  it("a price older than 1 hour stops mint, withdraw-with-debt and liquidate, but never deposit, repay or a debt-free exit", async function () {
    const { engine, ram, sita, gita, feed } = await fixture();
    await engine.connect(ram).depositAndMint(E(5000), { value: E(10) });
    await engine.connect(sita).deposit({ value: E(2) });
    await time.increase(3601);
    for (const p of [engine.connect(ram).mint(E(100)), engine.connect(ram).withdraw(E(1)), engine.connect(gita).liquidate(ram.address, E(1))]) {
      await expect(p).to.be.revertedWithCustomError(engine, "StalePrice");
    }
    await expect(engine.price()).to.be.revertedWithCustomError(engine, "StalePrice");
    await engine.connect(ram).deposit({ value: E(1) });
    await engine.connect(ram).repay(E(1000));
    await engine.connect(sita).withdraw(E(2)); // no debt: no price needed
    await feed.setPrice(USD(2000));
    await engine.connect(ram).mint(E(100)); // fresh again
  });

  it("STALE-PRICE ATTACK on the naive engine: minting at yesterday's $2,000 after a crash to $1,000 leaves EUSD worth 75 cents (F-01)", async function () {
    const { engine, naive, naiveEusd, attacker, feed } = await fixture();
    await time.increase(2 * 3600); // the reporter went quiet; meanwhile ETH really fell to $1,000
    await naive.connect(attacker).depositAndMint(E("13333.33"), { value: E(10) });
    expect(await naiveEusd.balanceOf(attacker.address)).to.equal(E("13333.33"));
    await expect(engine.connect(attacker).depositAndMint(E("13333.33"), { value: E(10) })).to.be.revertedWithCustomError(engine, "StalePrice");
    await feed.setPrice(USD(1000)); // the truth arrives
    expect(await naive.backing()).to.be.lt(E("0.76")); // $10,000 behind 13,333 EUSD = $0.75
  });

  it("CLAMPED-PRICE ATTACK (the LUNA lesson): the feed is stuck on its $500 floor while ETH trades at $300 (F-02)", async function () {
    const { engine, naive, naiveEusd, attacker, feed } = await fixture();
    await feed.setPrice(USD(300)); // the feed clamps this to $500
    expect((await feed.latestRoundData())[1]).to.equal(USD(500));
    // 100 ETH, really worth $30,000, are valued at $50,000 by the naive engine
    await naive.connect(attacker).depositAndMint(E("33333.33"), { value: E(100) });
    expect(await naiveEusd.balanceOf(attacker.address)).to.equal(E("33333.33")); // $30,000 behind 33,333 EUSD
    await expect(engine.connect(attacker).depositAndMint(E(1000), { value: E(100) })).to.be.revertedWithCustomError(engine, "PriceOutOfBounds");
    await expect(engine.price()).to.be.revertedWithCustomError(engine, "PriceOutOfBounds");
    // the same price ceiling rule at the top of the band
    await feed.setPrice(USD(200_000));
    await expect(engine.price()).to.be.revertedWithCustomError(engine, "PriceOutOfBounds");
  });

  it("refuses prices from the future, with no timestamp, from an unfinished round, or zero (F-03)", async function () {
    const { ram } = await fixture();
    const bad = await ethers.deployContract("BrokenFeed");
    const engine = await ethers.deployContract("DollarEngine", [await bad.getAddress(), E(1_000_000)]);
    await engine.connect(ram).deposit({ value: E(10) });
    const now = await time.latest();
    expect(await engine.price()).to.equal(E(2000));
    await bad.setRound(5, USD(2000), now + 600, 5);
    await expect(engine.price()).to.be.revertedWithCustomError(engine, "StalePrice");
    await bad.setRound(5, USD(2000), 0, 5);
    await expect(engine.price()).to.be.revertedWithCustomError(engine, "StalePrice");
    await bad.setRound(5, USD(2000), now, 4);
    await expect(engine.price()).to.be.revertedWithCustomError(engine, "IncompleteRound");
    await bad.setRound(5, 0, now, 5);
    await expect(engine.price()).to.be.revertedWithCustomError(engine, "PriceOutOfBounds");
    await bad.setRound(5, -USD(2000), now, 5);
    await expect(engine.connect(ram).mint(E(100))).to.be.revertedWithCustomError(engine, "PriceOutOfBounds");
  });

  it("reads feeds with other decimals correctly and refuses bad feeds at deployment", async function () {
    const bad = await ethers.deployContract("BrokenFeed");
    const B = await bad.getAddress();
    await bad.setDecimals(6);
    await bad.setBand(1_000000, 1_000_000_000000);
    await bad.setRound(1, 2000_000000, await time.latest(), 1);
    const e6 = await ethers.deployContract("DollarEngine", [B, E(1)]);
    expect(await e6.price()).to.equal(E(2000));
    await bad.setDecimals(19);
    await expect(ethers.deployContract("DollarEngine", [B, E(1)])).to.be.revertedWithCustomError(e6, "BadFeed");
    await bad.setDecimals(8);
    await bad.setBand(5, 5);
    await expect(ethers.deployContract("DollarEngine", [B, E(1)])).to.be.revertedWithCustomError(e6, "BadFeed");
    await bad.setBand(1, 5);
    await expect(ethers.deployContract("DollarEngine", [B, 0])).to.be.revertedWithCustomError(e6, "BadFeed");
  });

  it("DEPEG CHECK: after a 25% crash, liquidations keep every EUSD backed by more than $1 (F-04)", async function () {
    const { engine, eusd, feed, ram, sita, gita } = await fixture();
    await engine.connect(ram).depositAndMint(E(12_000), { value: E(10) }); // 166.7%
    await engine.connect(sita).depositAndMint(E(8_000), { value: E(10) }); // 250%
    await engine.connect(gita).depositAndMint(E(20_000), { value: E(100) }); // 1,000%
    await feed.setPrice(USD(1500)); // ETH −25%: Ram is at 125%
    expect(await engine.backing()).to.be.gt(E(1)); // still over-backed as a whole
    // liquidate Ram until he is safe again
    while (await engine.isLiquidatable(ram.address)) {
      const v = await engine.vaults(ram.address);
      await engine.connect(gita).liquidate(ram.address, v.debt / 2n);
    }
    expect(await engine.collateralRatio(ram.address)).to.be.gte(E("1.5"));
    expect(await engine.badDebt()).to.equal(0);
    expect(await engine.backing()).to.be.gt(E("1.5"));
    expect(await eusd.totalSupply()).to.equal(await engine.totalDebt());
  });

  it("ETH force-sent to the engine cannot make EUSD look better backed (F-06)", async function () {
    const { engine, ram, attacker } = await fixture();
    await engine.connect(ram).depositAndMint(E(10_000), { value: E(10) }); // $20,000 behind 10,000 EUSD
    expect(await engine.backing()).to.equal(E(2));
    await ethers.deployContract("ForceSend", [await engine.getAddress()], { signer: attacker, value: E(90) });
    expect(await ethers.provider.getBalance(await engine.getAddress())).to.equal(E(100));
    expect(await engine.backing()).to.equal(E(2)); // still $2.00, not $20.00
    expect(await engine.totalCollateral()).to.equal(E(10));
  });
});
