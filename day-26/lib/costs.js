// Day 26 — measure real transactions on both chains and price them with the L2 model.
const { ethers } = require("ethers");
const { devWallet } = require("./chains");
const { sendRaw } = require("./tx");
const { compare, DEFAULT_PRICES } = require("./gas-model");

/**
 * Run the same 3 actions on L1 and on L2 from dev account #3 and compare.
 * @returns rows: { action, gasL1, gasL2, txBytes, ...compare() }
 */
async function measureCosts(env, prices = DEFAULT_PRICES) {
  const actions = [
    { action: "Send ETH", build: () => ({ to: devWallet(4, env.l1.chain.provider).address, value: ethers.parseEther("0.01") }) },
    { action: "Add a task", build: (side) => ({ to: env[side].address.todo, data: env[side].todo.interface.encodeFunctionData("addTask", ["Buy momo for the team"]) }) },
    {
      action: "Send cross-chain message",
      build: (side) => {
        const other = side === "l1" ? "l2" : "l1";
        return {
          to: env[side].address.messenger,
          data: env[side].messenger.interface.encodeFunctionData("sendMessage", [
            env[other].chain.chainId, env[other].address.todo, ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["Buy momo for the team"]),
          ]),
        };
      },
    },
  ];
  const rows = [];
  for (const a of actions) {
    const r1 = await sendRaw(devWallet(3, env.l1.chain.provider), a.build("l1"));
    const r2 = await sendRaw(devWallet(3, env.l2.chain.provider), a.build("l2"));
    rows.push({ action: a.action, gasL1: Number(r1.receipt.gasUsed), gasL2: Number(r2.receipt.gasUsed), ...compare(r2.receipt.gasUsed, r2.raw, prices) });
  }
  return { rows, prices };
}

const usd = (x) => (x >= 0.01 ? `$${x.toFixed(2)}` : `$${x.toFixed(4)}`);

function formatCosts({ rows, prices }) {
  const lines = [
    `Prices assumed: L1 ${prices.l1GasPriceGwei} gwei, L2 ${prices.l2GasPriceGwei} gwei, ETH $${prices.ethUsd}, L1 data scalar ${prices.l1DataScalar} (OP Bedrock)`,
    "Action                     Gas (L1 = L2)   Tx bytes   L1 cost   L2 cost (exec + L1 data)    Cheaper",
  ];
  for (const r of rows) {
    lines.push(
      `${r.action.padEnd(26)} ${String(r.gasUsed).padStart(13)} ${String(r.txBytes).padStart(10)} ${usd(r.l1Usd).padStart(9)}   ` +
      `${usd(r.l2Usd).padStart(7)} (${Math.round((1 - r.dataShare) * 100)}% + ${Math.round(r.dataShare * 100)}%)`.padEnd(28) + `${r.times.toFixed(0).padStart(7)}×`,
    );
  }
  return lines.join("\n");
}

module.exports = { measureCosts, formatCosts, usd };
