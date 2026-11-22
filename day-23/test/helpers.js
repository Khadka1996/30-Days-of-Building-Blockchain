// Shared test setup: deploy the two contracts on the in-process Hardhat chain
// and give the indexer a viem client that talks to that same chain.
const { ethers, network, artifacts } = require("hardhat");
const { createPublicClient, custom } = require("viem");
const { Indexer } = require("../indexer/indexer");
const { MemoryStore } = require("../indexer/store");

/**
 * A viem client over Hardhat's provider. `hooks` lets a test play a hostile RPC:
 *   before(method, params) may throw (e.g. "block range too large");
 *   after(method, params, result) may change the chain (e.g. mine a block).
 */
function viemClient(hooks = {}) {
  const calls = [];
  const client = createPublicClient({
    transport: custom({
      async request({ method, params }) {
        calls.push({ method, params });
        if (hooks.before) await hooks.before(method, params);
        const result = await network.provider.request({ method, params });
        if (hooks.after) await hooks.after(method, params, result);
        return result;
      },
    }, { retryCount: 0 }), // fail fast in tests; the indexer itself must handle errors
    cacheTime: 0, // always ask the node: the chain can change under us
  });
  client.calls = calls;
  return client;
}

/** An RPC that refuses eth_getLogs over more than `maxBlocks` blocks (like Infura/Alchemy limits). */
function rangeLimit(maxBlocks) {
  return {
    async before(method, params) {
      if (method !== "eth_getLogs") return;
      const { fromBlock, toBlock } = params[0];
      const span = Number(BigInt(toBlock) - BigInt(fromBlock)) + 1;
      if (span > maxBlocks) {
        const err = new Error(`query exceeds max block range ${maxBlocks}`);
        err.code = -32005;
        throw err;
      }
    },
  };
}

async function deploy() {
  const todo = await ethers.deployContract("TodoList");
  const bank = await ethers.deployContract("PiggyBank");
  const t = await todo.deploymentTransaction().wait();
  const b = await bank.deploymentTransaction().wait();
  const contracts = [
    { name: "TodoList", address: await todo.getAddress(), startBlock: t.blockNumber, abi: (await artifacts.readArtifact("TodoList")).abi },
    { name: "PiggyBank", address: await bank.getAddress(), startBlock: b.blockNumber, abi: (await artifacts.readArtifact("PiggyBank")).abi },
  ];
  return { todo, bank, contracts, signers: await ethers.getSigners() };
}

function makeIndexer(contracts, opts = {}) {
  const { client = viemClient(), store = new MemoryStore(), IndexerClass = Indexer, ...rest } = opts;
  return new IndexerClass({ client, contracts, store, confirmations: 3, ...rest });
}

/** The truth: every log of our contracts on the CURRENT chain, read in one go. */
async function truth(contracts) {
  const head = await network.provider.request({ method: "eth_blockNumber", params: [] });
  const logs = await network.provider.request({
    method: "eth_getLogs",
    params: [{ address: contracts.map((c) => c.address), fromBlock: "0x0", toBlock: head }],
  });
  return logs.map((l) => `${l.blockHash}:${Number(l.logIndex)}`).sort();
}

const mine = (n = 1) => network.provider.send("hardhat_mine", ["0x" + n.toString(16)]);
const snapshot = () => network.provider.send("evm_snapshot");
const revert = (id) => network.provider.send("evm_revert", [id]);
const blockNumber = async () => Number(await network.provider.send("eth_blockNumber"));

module.exports = { viemClient, rangeLimit, deploy, makeIndexer, truth, mine, snapshot, revert, blockNumber };
