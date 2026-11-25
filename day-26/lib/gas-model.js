// Day 26 — how an L2 (optimistic rollup) charges you, in a few lines.
//
// On L1 you pay:   gas used × L1 gas price
// On an L2 you pay two things:
//   1. execution:  gas used × L2 gas price        (tiny: the L2 runs the code cheaply)
//   2. L1 data:    your transaction's bytes are posted to L1 so anyone can
//                  re-check the L2. You pay for that space on L1:
//                  (calldata gas of the raw tx + overhead) × scalar × L1 base fee
//
// Like a parcel service: the local delivery van (execution) is cheap, but every
// parcel also needs space on the big ship to the main warehouse (L1 data), and
// the ship charges by size. So on an L2, SMALLER transactions save the most.
//
// Formula: the OP Stack "Bedrock" L1 data fee. Newer versions (Ecotone, EIP-4844
// blobs) compress the data and use cheaper blob space, so real fees today are
// lower still; the shape (execution + data) is the same.

/** Default prices for the comparison (assumptions, printed next to every result). */
const DEFAULT_PRICES = {
  l1GasPriceGwei: 20,      // L1 gas price
  l2GasPriceGwei: 0.01,    // L2 execution gas price
  l1DataOverhead: 188,     // fixed gas per tx for batch overhead (Bedrock)
  l1DataScalar: 0.684,     // share of the cost after batching/compression (Bedrock)
  ethUsd: 3000,            // only to show dollars
};

/** Calldata gas of some bytes: 4 per zero byte, 16 per non-zero byte (EIP-2028). */
function calldataGas(hex) {
  const bytes = Buffer.from(hex.replace(/^0x/, ""), "hex");
  let gas = 0;
  for (const b of bytes) gas += b === 0 ? 4 : 16;
  return gas;
}

const GWEI = 1e-9;

/**
 * @param {bigint|number} gasUsed  from the real receipt
 * @param {string} rawTx           the real signed transaction (0x hex)
 * @returns cost in ETH and USD on L1 and on the L2, plus the parts.
 */
function compare(gasUsed, rawTx, prices = DEFAULT_PRICES) {
  const gas = Number(gasUsed);
  const dataGas = calldataGas(rawTx);
  const l1Eth = gas * prices.l1GasPriceGwei * GWEI;
  const l2ExecEth = gas * prices.l2GasPriceGwei * GWEI;
  const l2DataEth = (dataGas + prices.l1DataOverhead) * prices.l1DataScalar * prices.l1GasPriceGwei * GWEI;
  const l2Eth = l2ExecEth + l2DataEth;
  return {
    gasUsed: gas,
    txBytes: (rawTx.length - 2) / 2,
    dataGas,
    l1Eth, l2ExecEth, l2DataEth, l2Eth,
    l1Usd: l1Eth * prices.ethUsd,
    l2Usd: l2Eth * prices.ethUsd,
    times: l1Eth / l2Eth,
    dataShare: l2DataEth / l2Eth,
  };
}

module.exports = { DEFAULT_PRICES, calldataGas, compare };
