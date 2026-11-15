// Day 16 demo: lend, borrow, a year of interest, a liquidation, bad debt, then the two attacks.
// Run: npx hardhat run scripts/demo.js
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const E = (n) => ethers.parseEther(String(n));
const P = (usd) => BigInt(Math.round(usd * 1e8));
const YEAR = 365 * 24 * 60 * 60;
const fmt = (wei, dp = 2) =>
  Number(ethers.formatUnits(wei, 18)).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const pc = (wad) => `${(Number(ethers.formatUnits(wad, 18)) * 100).toFixed(2)}%`;
const hf = (wad) => Number(ethers.formatUnits(wad, 18)).toFixed(3);
const row = (label, value) => console.log(label.padEnd(50) + value);
const gas = async (txPromise) => (await (await txPromise).wait()).gasUsed.toString();

async function main() {
  const [owner, ram, sita, hari, gita, attacker] = await ethers.getSigners();
  const husd = await ethers.deployContract("HimalToken", ["Himal Dollar", "HUSD", E(10_000_000), owner.address]);
  const him = await ethers.deployContract("HimalToken", ["Himal Token", "HIM", E(10_000_000), owner.address]);
  const feed = await ethers.deployContract("HimalPriceFeed", [P(10), owner.address]);
  const lend = await ethers.deployContract("HimalLend", [await husd.getAddress(), await him.getAddress(), await feed.getAddress(), owner.address]);
  const pool = await lend.getAddress();
  for (const s of [ram, sita, hari, gita, attacker]) {
    await husd.transfer(s.address, E(100_000));
    await him.transfer(s.address, E(100_000));
    await husd.connect(s).approve(pool, ethers.MaxUint256);
    await him.connect(s).approve(pool, ethers.MaxUint256);
  }

  console.log("\n=== Himal Lend: lend HUSD, borrow against HIM ===");
  row("Ram lends 10,000 HUSD", `gas used: ${await gas(lend.connect(ram).deposit(E(10_000)))}`);
  row("Sita lends 10,000 HUSD", `gas used: ${await gas(lend.connect(sita).deposit(E(10_000)))}`);
  row("Hari locks 1,000 HIM (price $10 = $10,000)", `gas used: ${await gas(lend.connect(hari).depositCollateral(E(1_000)))}`);
  row("Hari borrows 7,000 HUSD (70% of value)", `gas used: ${await gas(lend.connect(hari).borrow(E(7_000)))}`);
  row("Hari tries 1,000 more (would be 80%)", await lend.connect(hari).borrow(E(1_000)).then(() => "allowed?!", (e) => `refused: ${e.message.match(/'(\w+)\(\)'/)[1]}`));
  row("Utilisation / borrow rate / lender rate", `${pc(await lend.utilization())} / ${pc(await lend.borrowRatePerYear(await lend.utilization()))} / ${pc(await lend.supplyRatePerYear())} a year`);
  row("Hari's health factor", hf(await lend.healthFactor(hari.address)));

  await time.increase(YEAR);
  await feed.setPrice(P(10));
  await lend.accrue();
  const debtYear = await lend.debtOf(hari.address);
  row("1 year later: Hari owes", `${fmt(debtYear)} HUSD (interest ${fmt(debtYear - E(7_000))})`);
  row("  lenders' share of the interest (90%)", `${fmt((await lend.totalAssets()) - E(20_000))} HUSD`);
  row("  reserves (10%)", `${fmt(await lend.reserves())} HUSD`);

  console.log("\n=== HIM falls to $8.50: a normal liquidation ===");
  await feed.setPrice(P(8.5));
  row("Hari's health factor", `${hf(await lend.healthFactor(hari.address))} (below 1.000 = liquidatable)`);
  let h0 = await him.balanceOf(gita.address);
  let u0 = await husd.balanceOf(gita.address);
  const g1 = await gas(lend.connect(gita).liquidate(hari.address, ethers.MaxUint256));
  let paid = u0 - (await husd.balanceOf(gita.address));
  let got = (await him.balanceOf(gita.address)) - h0;
  row("Gita repays (max 50% of the debt)", `${fmt(paid)} HUSD   gas used: ${g1}`);
  row("Gita receives", `${fmt(got)} HIM = $${fmt((got * P(8.5)) / 10n ** 8n)} (5% bonus)`);
  row("Hari's health factor after", hf(await lend.healthFactor(hari.address)));

  console.log("\n=== HIM crashes to $3: bad debt, written off openly ===");
  await feed.setPrice(P(3));
  await lend.accrue();
  const debtCrash = await lend.debtOf(hari.address);
  const collCrash = await lend.collateralValue(hari.address);
  row("Hari owes / his collateral is worth", `${fmt(debtCrash)} HUSD / $${fmt(collCrash)}`);
  const reservesBefore = await lend.reserves();
  h0 = await him.balanceOf(gita.address);
  u0 = await husd.balanceOf(gita.address);
  await lend.connect(gita).liquidate(hari.address, ethers.MaxUint256);
  paid = u0 - (await husd.balanceOf(gita.address));
  got = (await him.balanceOf(gita.address)) - h0;
  row("Gita repays / takes all the collateral", `${fmt(paid)} HUSD / ${fmt(got)} HIM`);
  row("Bad debt written off", `${fmt(await lend.totalBadDebt())} HUSD`);
  row("  paid by reserves first", `${fmt(reservesBefore - (await lend.reserves()))} HUSD`);
  for (const [name, l] of [["Ram", ram], ["Sita", sita]]) {
    const b = await husd.balanceOf(l.address);
    await lend.connect(l).redeem(await lend.sharesOf(l.address));
    row(`${name} withdraws everything`, `${fmt((await husd.balanceOf(l.address)) - b)} HUSD (lent 10,000.00)`);
  }
  row("Left in the pool", `${fmt(await lend.totalCash(), 6)} HUSD (nobody stuck)`);

  console.log("\n=== Attack 1: price manipulation with one big trade ===");
  for (const naive of [true, false]) {
    const r = await spotAttack({ husd, him, owner, attacker, naive });
    if (naive) {
      row("Swap pool spot price: before / after the buy", `$${(Number(r.priceBefore) / 1e8).toFixed(2)} / $${(Number(r.pumpedPrice) / 1e8).toFixed(2)}`);
      row("NAIVE pool (spot price): attacker borrows", `${fmt(r.borrowed)} HUSD against 4,200 HIM ($4,200)`);
      row("  attacker profit after selling back", `${fmt(r.profit)} HUSD; the pool is left with bad debt`);
    } else {
      row("HIMAL pool (price feed): borrow 50,000", `refused: Unhealthy (max ${fmt(r.maxBorrow)} HUSD)`);
    }
  }

  console.log("\n=== Attack 2: borrowing on an old price ===");
  await time.increase(2 * 60 * 60);
  await lend.connect(ram).deposit(E(1_000));
  await lend.connect(sita).depositCollateral(E(100));
  row("Feed last updated 2 hours ago: Sita borrows", await lend.connect(sita).borrow(E(1)).then(() => "allowed?!", (e) => `refused: ${e.message.match(/'(\w+)\(\)'/)[1]}`));
}

async function spotAttack({ husd, him, owner, attacker, naive }) {
  const pair = await ethers.deployContract("MiniPair", [await him.getAddress(), await husd.getAddress()]);
  const pa = await pair.getAddress();
  await him.approve(pa, ethers.MaxUint256);
  await husd.approve(pa, ethers.MaxUint256);
  await pair.addLiquidity(E(10_000), E(10_000));
  let target;
  if (naive) {
    target = await ethers.deployContract("NaiveSpotLending", [await husd.getAddress(), await him.getAddress(), pa]);
    await husd.approve(await target.getAddress(), ethers.MaxUint256);
    await target.fund(E(50_000));
  } else {
    const feed = await ethers.deployContract("HimalPriceFeed", [P(1), owner.address]);
    target = await ethers.deployContract("HimalLend", [await husd.getAddress(), await him.getAddress(), await feed.getAddress(), owner.address]);
    await husd.approve(await target.getAddress(), ethers.MaxUint256);
    await target.deposit(E(50_000));
  }
  const t = await target.getAddress();
  await him.connect(attacker).approve(pa, ethers.MaxUint256);
  await husd.connect(attacker).approve(pa, ethers.MaxUint256);
  await him.connect(attacker).approve(t, ethers.MaxUint256);
  // Start the attacker with exactly 30,000 HUSD and 0 HIM.
  await him.connect(attacker).transfer(owner.address, await him.balanceOf(attacker.address));
  const extra = (await husd.balanceOf(attacker.address)) - E(30_000);
  if (extra > 0n) await husd.connect(attacker).transfer(owner.address, extra);
  else await husd.transfer(attacker.address, -extra);

  const priceBefore = await pair.spotPrice();
  await pair.connect(attacker).swap(await husd.getAddress(), E(30_000));
  const pumpedPrice = await pair.spotPrice();
  await target.connect(attacker).depositCollateral(E(4_200));
  let borrowed = 0n;
  try { await target.connect(attacker).borrow(E(50_000)); borrowed = E(50_000); } catch (e) { /* refused */ }
  const maxBorrow = naive ? 0n : await target.maxBorrow(attacker.address);
  await pair.connect(attacker).swap(await him.getAddress(), await him.balanceOf(attacker.address));
  const profit = (await husd.balanceOf(attacker.address)) - E(30_000);
  return { priceBefore, pumpedPrice, borrowed, maxBorrow, profit };
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
