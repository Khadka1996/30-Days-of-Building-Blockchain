// Runs a real sandwich attack inside ONE block, the way it happens on a public chain:
// the attacker sees Ram's swap waiting, pays a higher tip to go first, and a lower tip to go right after.
const { ethers, network } = require("hardhat");
const { E, soon } = require("./helpers");

const GWEI = 10n ** 9n;
const fees = (tip) => ({ maxPriorityFeePerGas: tip * GWEI, maxFeePerGas: (tip + 200n) * GWEI, gasLimit: 400_000 });

/**
 * f: the fixture. Ram swaps `victimIn` HUSD for HIM with `victimMin` as his slippage limit.
 * The attacker buys `attackIn` HUSD of HIM first and sells it all straight after.
 * Returns what everyone got and whether each transaction succeeded.
 */
async function sandwich(f, { victimIn, victimMin, attackIn }) {
  const { router, ram, attacker, A, him, husd } = f;
  const path = [A.husd, A.him];
  const deadline = await soon();
  // The attacker knows exactly how much HIM the front-run will buy, because it goes first.
  const [, frontOut] = await router.getAmountsOut(attackIn, path);

  const ramHim0 = await him.balanceOf(ram.address);
  const atkHusd0 = await husd.balanceOf(attacker.address);

  await network.provider.send("evm_setAutomine", [false]);
  let txs;
  try {
    const front = await router
      .connect(attacker)
      .swapExactTokensForTokens(attackIn, 0, path, attacker.address, deadline, fees(100n));
    const victim = await router
      .connect(ram)
      .swapExactTokensForTokens(victimIn, victimMin, path, ram.address, deadline, fees(2n));
    const back = await router
      .connect(attacker)
      .swapExactTokensForTokens(frontOut, 0, [A.him, A.husd], attacker.address, deadline, fees(1n));
    txs = [front, victim, back];
    await network.provider.send("evm_mine");
  } finally {
    await network.provider.send("evm_setAutomine", [true]);
  }
  const receipts = await Promise.all(txs.map((t) => ethers.provider.getTransactionReceipt(t.hash)));
  const order = receipts.map((r) => r.index);
  return {
    sameBlock: receipts.every((r) => r.blockNumber === receipts[0].blockNumber),
    order, // transaction positions inside the block
    status: receipts.map((r) => r.status), // 1 = success, 0 = reverted
    ramGot: (await him.balanceOf(ram.address)) - ramHim0,
    attackerProfit: (await husd.balanceOf(attacker.address)) - atkHusd0, // can be negative
  };
}

module.exports = { sandwich, E };
