// Shared test setup: two real local chains (separate hardhat nodes), the
// contracts on both, validators, and helpers to sign and deliver messages.
const { ethers } = require("ethers");
const { startChains, devWallet } = require("../lib/chains");
const { deployBoth, artifact } = require("../lib/deploy");
const { hashMessage } = require("../relayer/relayer");

const IFACE = new ethers.Interface(artifact("Messenger").abi);

/** Start L1+L2 on the given ports, deploy, and return an env object. */
async function setup(l1Port, l2Port) {
  const chains = await startChains({ l1Port, l2Port });
  const env = await deployBoth(chains);
  env.chains = chains;
  env.user = { l1: devWallet(1, chains.l1.provider), l2: devWallet(1, chains.l2.provider) };
  env.attacker = { l1: devWallet(2, chains.l1.provider), l2: devWallet(2, chains.l2.provider) };
  env.submitterKey = devWallet(9, chains.l1.provider).privateKey;
  return env;
}

const snapshot = async (env) => [await env.chains.l1.provider.send("evm_snapshot", []), await env.chains.l2.provider.send("evm_snapshot", [])];
const revert = async (env, ids) => {
  await env.chains.l1.provider.send("evm_revert", [ids[0]]);
  await env.chains.l2.provider.send("evm_revert", [ids[1]]);
};

/** Send a message on `from` (l1/l2) from `wallet`. Returns the Message (as a plain object) and id. */
async function send(env, from, wallet, { target, data, dst } = {}) {
  const to = from === "l1" ? "l2" : "l1";
  const tx = await env[from].messenger.connect(wallet).sendMessage(
    dst ?? env[to].chain.chainId,
    target ?? env[to].address.todo,
    data ?? ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["Buy momo"]),
  );
  const receipt = await tx.wait();
  const ev = receipt.logs.map((l) => { try { return IFACE.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "MessageSent");
  return { message: toPlain(ev.args.message), id: ev.args.id, receipt };
}

function toPlain(m) {
  return {
    srcChainId: BigInt(m.srcChainId), srcMessenger: m.srcMessenger, dstChainId: BigInt(m.dstChainId),
    dstMessenger: m.dstMessenger, nonce: BigInt(m.nonce), sender: m.sender, target: m.target, data: m.data,
  };
}

/** Signatures from the given signers over the message id, sorted by signer (as the contract wants). */
async function sign(message, signers) {
  const id = hashMessage(message);
  const sorted = [...signers].sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
  return Promise.all(sorted.map((s) => s.signMessage(ethers.getBytes(id))));
}

/** Mine n empty blocks on a chain. */
const mine = (chain, n = 1) => chain.provider.send("hardhat_mine", ["0x" + n.toString(16)]);

const encodeText = (t) => ethers.AbiCoder.defaultAbiCoder().encode(["string"], [t]);

module.exports = { setup, snapshot, revert, send, sign, mine, encodeText, toPlain, IFACE, devWallet, hashMessage };
