const { ethers } = require("hardhat");
const { time, mine } = require("@nomicfoundation/hardhat-network-helpers");

const E = (n) => ethers.parseEther(String(n));
const MAX = ethers.MaxUint256;
const fee = (amount) => (amount * 9n + 9999n) / 10000n; // 0.09%, rounded up

async function soon(minutes = 20) {
  return (await time.latest()) + minutes * 60;
}

// The Day 18 world:
//   Two exchanges built from Day 17's contracts, with HIM at different prices:
//     Himal Swap    100,000 HIM : 1,000,000 HUSD   (1 HIM = 10 HUSD)
//     Everest Swap   50,000 HIM :   600,000 HUSD   (1 HIM = 12 HUSD)
//   A flash lender holding 2,000,000 HUSD and 1,000,000 HIM, fee 0.09%.
//   A loyalty bonus pot of 10,000 HUSD: 1 HUSD per 10 HIM held. Ram holds 1,000 HIM, Sita 5,000.
//   The snapshot block is taken after Ram and Sita delegated, before the attacker gets any HIM.
async function baseFixture() {
  const [owner, ram, sita, attacker, manish] = await ethers.getSigners();
  const him = await ethers.deployContract("HimalVotesToken", [E(1_000_000_000), owner.address]);
  const husd = await ethers.deployContract("HimalToken", ["Himal Dollar", "HUSD", E(1_000_000_000), owner.address]);
  const A = { him: await him.getAddress(), husd: await husd.getAddress() };

  // Two exchanges (Day 17's factory + router), each with one HIM/HUSD pool.
  const dex = async (himAmt, husdAmt) => {
    const factory = await ethers.deployContract("HimalFactory");
    const router = await ethers.deployContract("HimalRouter", [await factory.getAddress(), [A.husd]]);
    const r = await router.getAddress();
    await him.approve(r, MAX);
    await husd.approve(r, MAX);
    await router.addLiquidity(A.him, A.husd, himAmt, husdAmt, 0, 0, owner.address, await soon());
    const pair = await ethers.getContractAt("HimalPair", await factory.getPair(A.him, A.husd));
    return { factory, router, r, pair };
  };
  const himal = await dex(E(100_000), E(1_000_000));
  const everest = await dex(E(50_000), E(600_000));

  // The flash lender.
  const lender = await ethers.deployContract("HimalFlashLender", [owner.address]);
  const L = await lender.getAddress();
  await lender.setSupported(A.husd, true);
  await lender.setSupported(A.him, true);
  await husd.transfer(L, E(2_000_000));
  await him.transfer(L, E(1_000_000));

  // Manish's arbitrage bot.
  const bot = await ethers.deployContract("FlashArbitrage", [L, manish.address]);

  // Bonus: holders delegate to themselves (Day 14), then a snapshot block is mined.
  await him.transfer(ram.address, E(1_000));
  await him.transfer(sita.address, E(5_000));
  await him.connect(ram).delegate(ram.address);
  await him.connect(sita).delegate(sita.address);
  await mine(1);
  const snapshotBlock = (await ethers.provider.getBlockNumber()) - 1;
  const naive = await ethers.deployContract("NaiveBonus", [A.him, A.husd]);
  const safe = await ethers.deployContract("SafeBonus", [A.him, A.husd, snapshotBlock]);
  await husd.transfer(await naive.getAddress(), E(10_000));
  await husd.transfer(await safe.getAddress(), E(10_000));

  // The attacker only gets HIM AFTER the snapshot: just enough to pay a flash-loan fee.
  await him.transfer(attacker.address, E(1_000));

  return { owner, ram, sita, attacker, manish, him, husd, A, himal, everest, lender, L, bot, naive, safe, snapshotBlock };
}

// What the round trip HUSD → HIM (cheap DEX) → HUSD (dear DEX) gives, from the routers' own quotes.
async function quoteRoundTrip(f, amount) {
  const [, himOut] = await f.himal.router.getAmountsOut(amount, [f.A.husd, f.A.him]);
  const [, husdOut] = await f.everest.router.getAmountsOut(himOut, [f.A.him, f.A.husd]);
  return { himOut, husdOut, profit: husdOut - amount - fee(amount) };
}

async function trade(f, minProfit = 0n) {
  return {
    buyRouter: f.himal.r,
    sellRouter: f.everest.r,
    buyPath: [f.A.husd, f.A.him],
    sellPath: [f.A.him, f.A.husd],
    minProfit,
    deadline: await soon(),
  };
}

module.exports = { E, MAX, fee, soon, baseFixture, quoteRoundTrip, trade };
