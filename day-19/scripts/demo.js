// Day 19 demo: lock ETH, mint Everest Dollars (EUSD), liquidations when ETH falls, bad debt in a
// crash, a price-feed outage, and the two price attacks on a naive engine (stale and clamped prices).
// Run: npx hardhat run scripts/demo.js
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { E, USD, baseFixture } = require("../test/helpers");

const fmt = (wei, dp = 2) =>
  Number(ethers.formatUnits(wei, 18)).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const pct = (ratio) => (ratio === ethers.MaxUint256 ? "no debt" : `${(Number(ratio) / 1e16).toFixed(1)}%`);
const row = (label, value) => console.log(label.padEnd(50) + value);
const gas = async (txPromise) => (await (await txPromise).wait()).gasUsed.toString();
const why = (e) => (e.message.match(/custom error '(\w+)/) || [, "reverted"])[1];
async function refused(p) {
  try {
    await (await p).wait();
    return "NOT refused";
  } catch (e) {
    return `refused: ${why(e)}`;
  }
}

async function main() {
  const f = await baseFixture();
  const { engine, eusd, feed, ram, sita, gita } = f;

  console.log("\n=== Everest Dollar: lock ETH, mint EUSD (min 150%) ===");
  row("ETH price (feed, band $500 … $100,000)", `$${fmt(await engine.price())}`);
  row("Ram locks 10 ETH ($20,000), mints 12,000 EUSD", `gas used: ${await gas(engine.connect(ram).depositAndMint(E(12_000), { value: E(10) }))}`);
  row("  Ram's collateral ratio", pct(await engine.collateralRatio(ram.address)));
  row("  Ram tries 1,400 more (limit 13,333.33)", await refused(engine.connect(ram).mint(E(1400))));
  await engine.connect(sita).depositAndMint(E(5_000), { value: E(10) });
  row("Sita locks 10 ETH, mints 5,000 EUSD", pct(await engine.collateralRatio(sita.address)));
  await engine.connect(gita).depositAndMint(E(50_000), { value: E(100) });
  row("Gita (a liquidator) locks 100 ETH, mints 50,000", pct(await engine.collateralRatio(gita.address)));
  row("EUSD in circulation / backing per EUSD", `${fmt(await eusd.totalSupply())} / $${fmt(await engine.backing())}`);

  console.log("\n=== ETH falls 15% to $1,700: a normal liquidation ===");
  await feed.setPrice(USD(1700));
  row("Ram's collateral ratio", `${pct(await engine.collateralRatio(ram.address))} (below 150% = liquidatable)`);
  const before = await ethers.provider.getBalance(gita.address);
  const tx = await engine.connect(gita).liquidate(ram.address, E(6000));
  const r = await tx.wait();
  const got = (await ethers.provider.getBalance(gita.address)) - before + r.gasUsed * r.gasPrice;
  row("Gita burns 6,000 EUSD (max 50% of the debt)", `gas used: ${r.gasUsed}`);
  row("  Gita receives", `${fmt(got, 4)} ETH = $${fmt((got * 1700n))} (10% bonus)`);
  row("  Ram's collateral ratio after", pct(await engine.collateralRatio(ram.address)));
  row("Backing per EUSD", `$${fmt(await engine.backing())}`);

  console.log("\n=== ETH crashes to $900: under 110% the vault closes in one go ===");
  await feed.setPrice(USD(900));
  const v = await engine.vaults(ram.address);
  row("Ram owes / his ETH is worth", `${fmt(v.debt)} EUSD / $${fmt(v.collateral * 900n)} (${pct(await engine.collateralRatio(ram.address))})`);
  row("Gita tries to repay just half", await refused(engine.connect(gita).liquidate(ram.address, v.debt / 2n)));
  const value = v.collateral * 900n;
  const repay = (value * 10n + 10n) / 11n; // the ETH's value minus the 10% bonus, rounded up
  await engine.connect(gita).liquidate(ram.address, repay);
  row("Gita burns / takes ALL the ETH", `${fmt(repay)} EUSD / ${fmt(v.collateral, 4)} ETH`);
  row("Bad debt written off (EUSD with no ETH behind)", `${fmt(await engine.badDebt())} EUSD, shown openly`);
  row("Backing per EUSD (whole system)", `$${fmt(await engine.backing())} (still above $1)`);

  console.log("\n=== The price feed goes quiet for 2 hours ===");
  await time.increase(2 * 3600);
  row("Sita mints 100 EUSD", await refused(engine.connect(sita).mint(E(100))));
  row("Gita liquidates anyone", await refused(engine.connect(gita).liquidate(sita.address, E(100))));
  await engine.connect(sita).repay(E(1000));
  row("Sita repays 1,000 EUSD (makes things safer)", "allowed");
  await engine.connect(sita).deposit({ value: E(1) });
  row("Sita adds 1 ETH (makes things safer)", "allowed");

  console.log("\n=== Attack 1: mint on a stale price (ETH really fell from $2,000 to $1,000) ===");
  const a = await baseFixture();
  await time.increase(2 * 3600);
  row("NAIVE engine: 10 ETH → 13,333.33 EUSD", `gas used: ${await gas(a.naive.connect(a.attacker).depositAndMint(E("13333.33"), { value: E(10) }))}`);
  row("SAFE engine: same", await refused(a.engine.connect(a.attacker).depositAndMint(E("13333.33"), { value: E(10) })));
  await a.feed.setPrice(USD(1000));
  row("The truth arrives: naive backing per EUSD", `$${fmt(await a.naive.backing())} (the coin has lost its peg)`);

  console.log("\n=== Attack 2: the feed is stuck on its $500 floor while ETH trades at $300 (LUNA) ===");
  const b = await baseFixture();
  await b.feed.setPrice(USD(300));
  row("Feed reports", `$${Number((await b.feed.latestRoundData())[1]) / 1e8} (clamped to its minAnswer)`);
  await b.naive.connect(b.attacker).depositAndMint(E("33333.33"), { value: E(100) });
  row("NAIVE engine: 100 ETH ($30,000) → 33,333.33 EUSD", `real backing per EUSD $${fmt((E(30_000) * E(1)) / E("33333.33"))}`);
  row("SAFE engine: same", await refused(b.engine.connect(b.attacker).depositAndMint(E("33333.33"), { value: E(100) })));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
