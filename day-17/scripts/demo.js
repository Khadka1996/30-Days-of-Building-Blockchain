// Day 17 demo: three pools, a router that finds the best path, slippage, a real sandwich attack
// inside one block (with and without a slippage limit), and a swap that waited too long.
// Run: npx hardhat run scripts/demo.js
const { ethers, network } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { E, soon, baseFixture, reservesOf } = require("../test/helpers");
const { sandwich } = require("../test/sandwich");

const fmt = (wei, dp = 2) =>
  Number(ethers.formatUnits(wei, 18)).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const row = (label, value) => console.log(label.padEnd(50) + value);
const gas = async (txPromise) => (await (await txPromise).wait()).gasUsed.toString();
const why = (e) => (e.message.match(/custom error '(\w+)/) || e.message.match(/'(\w+)\(/) || [, "reverted"])[1];

async function main() {
  const f = await baseFixture();
  const { router, ram, sita, A, him, husd, nprt, pairOf } = f;
  const name = { [A.him]: "HIM", [A.husd]: "HUSD", [A.nprt]: "NPRT" };
  const show = (path) => path.map((a) => name[a]).join(" → ");

  console.log("\n=== Himal Swap: three pools (x × y = k, 0.3% fee) ===");
  for (const [a, b, label] of [[him, husd, "HIM/HUSD"], [husd, nprt, "HUSD/NPRT"], [him, nprt, "HIM/NPRT (thin)"]]) {
    const [ra, rb] = await reservesOf(await pairOf(a, b), await a.getAddress());
    row(label, `${fmt(ra, 0)} : ${fmt(rb, 0)}   price ${fmt((rb * E(1)) / ra)}`);
  }

  console.log("\n=== Ram sells 1,000 HIM for NPRT: the router finds the path ===");
  const direct = (await router.getAmountsOut(E(1_000), [A.him, A.nprt]))[1];
  const [path, best] = await router.bestPath(A.him, A.nprt, E(1_000));
  row("Direct pool HIM → NPRT would give", `${fmt(direct)} NPRT`);
  row("bestPath chooses", `${show(path)}: ${fmt(best)} NPRT`);
  const minOut = (best * 995n) / 1000n;
  const n0 = await nprt.balanceOf(ram.address);
  const g = await gas(router.connect(ram).swapExactTokensForTokens(E(1_000), minOut, [...path], ram.address, await soon()));
  row("Ram swaps with a 0.5% slippage limit", `got ${fmt((await nprt.balanceOf(ram.address)) - n0)} NPRT   gas used: ${g}`);
  row("Router balance after (it never holds tokens)", `${fmt((await him.balanceOf(f.r)) + (await husd.balanceOf(f.r)) + (await nprt.balanceOf(f.r)))}`);

  console.log("\n=== Sita buys exactly 1,000 HIM (exact output) ===");
  const [need] = await router.getAmountsIn(E(1_000), [A.husd, A.him]);
  const g2 = await gas(router.connect(sita).swapTokensForExactTokens(E(1_000), (need * 1005n) / 1000n, [A.husd, A.him], sita.address, await soon()));
  row("She pays", `${fmt(need)} HUSD (limit +0.5%)   gas used: ${g2}`);

  console.log("\n=== Price impact: bigger trades get worse prices ===");
  for (const size of [1_000, 10_000, 100_000]) {
    const [rHusd, rHim] = await reservesOf(await pairOf(husd, him), A.husd);
    const [, out] = await router.getAmountsOut(E(size), [A.husd, A.him]);
    const spot = (E(size) * rHim) / rHusd;
    const impact = Number(((spot - out) * 10000n) / spot) / 100;
    row(`Buy HIM with ${size.toLocaleString("en-US")} HUSD`, `${fmt(out)} HIM, ${impact.toFixed(2)}% worse than spot (incl. fee)`);
  }

  console.log("\n=== Attack: a sandwich in ONE block (attacker tip 100 gwei, Ram 2, attacker 1) ===");
  const [, fair] = await router.getAmountsOut(E(50_000), [A.husd, A.him]);
  row("Ram swaps 50,000 HUSD; the fair quote is", `${fmt(fair)} HIM`);
  const snap = await network.provider.send("evm_snapshot", []);
  const a = await sandwich(f, { victimIn: E(50_000), victimMin: 0n, attackIn: E(200_000) });
  row("NO slippage limit (amountOutMin = 0)", `order in block: ${a.order.join(", ")}, all succeed`);
  row("  Ram gets", `${fmt(a.ramGot)} HIM (${((Number(fair - a.ramGot) * 100) / Number(fair)).toFixed(2)}% less)`);
  row("  attacker profit", `${fmt(a.attackerProfit)} HUSD, in one block`);
  await network.provider.send("evm_revert", [snap]);
  const b = await sandwich(f, { victimIn: E(50_000), victimMin: (fair * 995n) / 1000n, attackIn: E(200_000) });
  row("WITH a 0.5% limit", `Ram's swap ${b.status[1] === 0 ? "reverts: InsufficientOutputAmount" : "succeeds?!"}`);
  row("  Ram loses", `0 HUSD (he keeps his money, pays only gas)`);
  row("  attacker profit", `${fmt(b.attackerProfit)} HUSD (two fees, no victim)`);

  console.log("\n=== A swap that waited 2 hours in the queue ===");
  const deadline = await soon(20);
  await time.increase(2 * 60 * 60);
  row("Deadline was 20 minutes", await router.connect(ram).swapExactTokensForTokens(E(1), 0, [A.him, A.husd], ram.address, deadline).then(() => "ran?!", (e) => `refused: ${why(e)}`));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
