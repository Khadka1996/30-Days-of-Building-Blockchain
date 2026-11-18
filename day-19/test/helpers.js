const { ethers } = require("hardhat");

const E = (n) => ethers.parseEther(String(n));
const USD = (n) => BigInt(Math.round(Number(n) * 1e8)); // feed answer, 8 decimals
const WAD = 10n ** 18n;
const MIN_RATIO = 15n * 10n ** 17n; // 150%
const BONUS = 10n ** 17n; // 10%

// The Day 19 world:
//   ETH/USD feed at $2,000, with a Chainlink-style circuit-breaker band of $500 … $100,000.
//   The DollarEngine (safe) and a NaiveDollarEngine (trusts the feed blindly) both read it.
//   Debt ceiling: 10,000,000 EUSD.
async function baseFixture() {
  const [reporter, ram, sita, gita, attacker] = await ethers.getSigners();
  const feed = await ethers.deployContract("EthUsdFeed", [USD(2000), USD(500), USD(100_000), reporter.address]);
  const F = await feed.getAddress();
  const engine = await ethers.deployContract("DollarEngine", [F, E(10_000_000)]);
  const eusd = await ethers.getContractAt("EverestDollar", await engine.eusd());
  const naive = await ethers.deployContract("NaiveDollarEngine", [F, E(10_000_000)]);
  const naiveEusd = await ethers.getContractAt("EverestDollar", await naive.eusd());
  return { reporter, ram, sita, gita, attacker, feed, F, engine, eusd, naive, naiveEusd };
}

// The same maths as the contract, in JavaScript, so tests can predict exact results.
const value = (collateral, price18) => (collateral * price18) / WAD;
const healthy = (collateral, debt, price18) => value(collateral, price18) * WAD >= debt * MIN_RATIO;
const seizeFor = (amount, price18) => (amount * (WAD + BONUS)) / price18;
// Closing zone (under 110%): the whole vault closes; `needed` is the least the liquidator must repay.
const closing = (collateral, debt, price18) => value(collateral, price18) * WAD < debt * (WAD + BONUS);
const needed = (collateral, debt, price18) => {
  const v = value(collateral, price18);
  return v >= debt ? debt : (v * WAD + WAD + BONUS - 1n) / (WAD + BONUS);
};

module.exports = { E, USD, WAD, MIN_RATIO, BONUS, baseFixture, value, healthy, seizeFor, closing, needed };
