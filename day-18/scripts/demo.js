// Day 18 demo: an ERC-3156 flash lender, a flash-loan arbitrage between two exchanges,
// a flash-loan attack on a naive bonus (and the fix), and a stranger trying to drain a bot.
// Run: npx hardhat run scripts/demo.js
const { ethers } = require("hardhat");
const { E, MAX, fee, baseFixture, quoteRoundTrip, trade } = require("../test/helpers");

const fmt = (wei, dp = 2) =>
  Number(ethers.formatUnits(wei, 18)).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const row = (label, value) => console.log(label.padEnd(50) + value);
const gas = async (txPromise) => (await (await txPromise).wait()).gasUsed.toString();
const why = (e) => (e.message.match(/custom error '(\w+)/) || e.message.match(/reverted with reason string '([^']+)'/) || [, "reverted"])[1];

async function price(pair, him) {
  const [r0, r1] = await pair.getReserves();
  return (await pair.token0()) === him ? (r1 * E(1)) / r0 : (r0 * E(1)) / r1;
}

async function main() {
  const f = await baseFixture();
  const { lender, L, him, husd, A, bot, manish, attacker, ram, sita } = f;

  console.log("\n=== The flash lender (ERC-3156, fee 0.09% rounded up) ===");
  row("Can lend", `${fmt(await lender.maxFlashLoan(A.husd), 0)} HUSD and ${fmt(await lender.maxFlashLoan(A.him), 0)} HIM`);
  row("Fee on 1,000,000 HUSD", `${fmt(await lender.flashFee(A.husd, E(1_000_000)))} HUSD`);
  row("Fee on a 1-wei loan", `${await lender.flashFee(A.husd, 1n)} wei (never free)`);

  console.log("\n=== Two exchanges, two prices for HIM ===");
  row("Himal Swap   (100,000 HIM : 1,000,000 HUSD)", `1 HIM = ${fmt(await price(f.himal.pair, A.him))} HUSD`);
  row("Everest Swap  (50,000 HIM :   600,000 HUSD)", `1 HIM = ${fmt(await price(f.everest.pair, A.him))} HUSD`);

  console.log("\n=== Arbitrage: borrow HUSD, buy HIM cheap, sell dear, repay ===");
  let best = { amount: 0n, profit: -1n };
  for (let k = 1_000; k <= 200_000; k += 1_000) {
    const q = await quoteRoundTrip(f, E(k));
    if (q.profit > best.profit) best = { amount: E(k), profit: q.profit };
  }
  for (const k of [10_000, 50_000, 200_000, 400_000]) {
    const q = await quoteRoundTrip(f, E(k));
    row(`  borrow ${k.toLocaleString("en-US")} HUSD`, `profit ${fmt(q.profit)} HUSD`);
  }
  row("Best size (searched in steps of 1,000)", `${fmt(best.amount, 0)} HUSD → profit ${fmt(best.profit)} HUSD`);
  const g = await gas(bot.connect(manish).run(best.amount, await trade(f, best.profit)));
  row("Manish runs the bot (own money: 0 HUSD)", `received ${fmt(await husd.balanceOf(manish.address))} HUSD   gas used: ${g}`);
  row("Lender earned", `${fmt(await lender.feesEarned(A.husd))} HUSD fee (= ${fmt(fee(best.amount))})`);
  row("Bot keeps after the run", `${fmt(await husd.balanceOf(await bot.getAddress()))} HUSD, ${fmt(await him.balanceOf(await bot.getAddress()))} HIM`);
  row("Prices after", `Himal ${fmt(await price(f.himal.pair, A.him))} · Everest ${fmt(await price(f.everest.pair, A.him))}`);
  try {
    await bot.connect(manish).run(best.amount, await trade(f, 1n));
  } catch (e) {
    row("Run it again (the gap is gone)", `refused: ${why(e)}, nothing lost but gas`);
  }

  console.log("\n=== Attack: look rich for one transaction (bonus 1 HUSD per 10 HIM, pot 10,000 HUSD) ===");
  const atk = await ethers.deployContract("BonusAttacker", [L, A.him, A.husd], attacker);
  await him.connect(attacker).approve(await atk.getAddress(), MAX);
  const loan = E(100_000);
  row("Attacker holds", `${fmt(await him.balanceOf(attacker.address), 0)} HIM (bought after the snapshot)`);
  const ga = await gas(atk.connect(attacker).attack(await f.naive.getAddress(), loan, fee(loan)));
  row("NaiveBonus: flash-borrow 100,000 HIM and claim", `attacker got ${fmt(await husd.balanceOf(attacker.address))} HUSD   gas used: ${ga}`);
  row("  cost to the attacker", `${fmt(fee(loan))} HIM fee (about ${fmt(fee(loan) * 10n)} HUSD)`);
  try {
    await f.naive.connect(ram).claim();
  } catch (e) {
    row("  Ram (a real holder of 1,000 HIM) claims", `refused: ${why(e)}, the pot is empty`);
  }
  try {
    await atk.connect(attacker).attack(await f.safe.getAddress(), loan, fee(loan));
  } catch (e) {
    row("SafeBonus (balance at a past block): same attack", `reverts: ${why(e)}, pot still ${fmt(await husd.balanceOf(await f.safe.getAddress()), 0)} HUSD`);
  }
  await f.safe.connect(ram).claim();
  await f.safe.connect(sita).claim();
  row("  Ram and Sita claim from SafeBonus", `${fmt(await husd.balanceOf(ram.address))} and ${fmt(await husd.balanceOf(sita.address))} HUSD (exactly 1 per 10 HIM)`);

  console.log("\n=== Attack: a stranger starts flash loans FOR someone else's bot ===");
  const naive = await ethers.deployContract("NaiveBorrower", [L]);
  const N = await naive.getAddress();
  await husd.transfer(N, E(1_000));
  await lender.connect(attacker).flashLoan(N, A.husd, E(1_000_000), "0x");
  row("Bot WITHOUT the initiator check (1,000 saved)", `after one loan: ${fmt(await husd.balanceOf(N))} HUSD left (paid the 900 fee)`);
  const B = await bot.getAddress();
  await husd.transfer(B, E(1_000));
  try {
    await lender.connect(attacker).flashLoan(B, A.husd, E(1_000_000), "0x");
  } catch (e) {
    row("FlashArbitrage (checks initiator)", `refused: ${why(e)}, still ${fmt(await husd.balanceOf(B))} HUSD`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
