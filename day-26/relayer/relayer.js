// Day 26 — validators and the relayer that carry messages between the two chains (viem).
//
//   source chain                      off-chain                          destination chain
//   Messenger.sendMessage ──event──▶  relayer finds the event
//                                     (only after N confirmations)
//                                     ──▶ each validator checks it ON ITS OWN:
//                                         * the tx receipt really has this log
//                                         * emitted by the REAL source Messenger
//                                         * enough confirmations (reorg safety)
//                                         * recomputes the id from the fields
//                                       and signs the id
//                                     relayer sorts 2-of-3 signatures,   ──▶ Messenger.receiveMessage
//                                     simulates, then sends                  (checks it all again)
//
// The relayer itself is NOT trusted: it can't forge or change a message, because
// the contract checks the validators' signatures over every field. The worst a
// relayer can do is not deliver (then anyone else can run one).
const {
  createPublicClient, createWalletClient, http, defineChain, getAddress, parseAbiItem,
  decodeEventLog, encodeAbiParameters, keccak256, toHex, isAddressEqual,
} = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const { artifact } = require("../lib/deploy");

const MESSENGER_ABI = artifact("Messenger").abi;
const MESSAGE_SENT = MESSENGER_ABI.find((x) => x.type === "event" && x.name === "MessageSent");
const MESSAGE_TYPEHASH = keccak256(toHex(
  "Message(uint256 srcChainId,address srcMessenger,uint256 dstChainId,address dstMessenger,uint256 nonce,address sender,address target,bytes data)"
));

function chainOf({ chainId, url, name }) {
  return defineChain({ id: chainId, name, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [url] } } });
}

function clientFor(chain) {
  return createPublicClient({ chain: chainOf(chain), transport: http(chain.url, { retryCount: 0 }), pollingInterval: 50, cacheTime: 0 });
}

/** The message id, computed exactly like Messenger.hashMessage. */
function hashMessage(m) {
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "address" },
      { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes32" }],
    [MESSAGE_TYPEHASH, m.srcChainId, m.srcMessenger, m.dstChainId, m.dstMessenger, m.nonce, m.sender, m.target, keccak256(m.data)],
  ));
}

/**
 * One validator. It trusts nothing it is told: given only (txHash, logIndex) it
 * reads the source chain itself and signs only if everything checks out.
 */
function createValidator({ privateKey, src, srcMessenger, dstChainId, dstMessenger, confirmations = 2 }) {
  const account = privateKeyToAccount(privateKey);
  const client = clientFor(src);
  return {
    address: account.address,
    /** @returns {Promise<{ id, message, signature }>} or throws with a reason */
    async attest(txHash, logIndex) {
      const receipt = await client.getTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") throw new Error("source tx failed");
      const log = receipt.logs.find((l) => l.logIndex === logIndex);
      if (!log) throw new Error("no such log");
      if (!isAddressEqual(log.address, srcMessenger)) throw new Error("log not from the source Messenger");
      const head = await client.getBlockNumber();
      if (head - receipt.blockNumber + 1n < BigInt(confirmations)) throw new Error("not enough confirmations");
      // the block must still be on the canonical chain (a reorg would change its hash)
      const block = await client.getBlock({ blockNumber: receipt.blockNumber });
      if (block.hash !== receipt.blockHash) throw new Error("block was reorganised");
      const ev = decodeEventLog({ abi: [MESSAGE_SENT], data: log.data, topics: log.topics });
      const message = ev.args.message;
      if (message.srcChainId !== BigInt(src.chainId)) throw new Error("wrong source chain");
      if (!isAddressEqual(message.srcMessenger, srcMessenger)) throw new Error("wrong source messenger");
      if (message.dstChainId !== BigInt(dstChainId) || !isAddressEqual(message.dstMessenger, dstMessenger)) throw new Error("wrong destination");
      const id = hashMessage(message);
      if (id !== ev.args.id) throw new Error("id does not match fields");
      const signature = await account.signMessage({ message: { raw: id } });
      return { id, message, signature };
    },
  };
}

/**
 * A one-way relayer src → dst. Call `poll()` to deliver everything new.
 * `submitterKey` pays gas on the destination chain.
 */
function createRelayer({
  src, dst, srcMessenger, dstMessenger, validators, threshold, submitterKey,
  confirmations = 2, fromBlock = 0n, allowedTargets, maxRetriesPerPoll = 10, log = () => {},
}) {
  const srcClient = clientFor(src);
  const dstClient = clientFor(dst);
  const wallet = createWalletClient({ chain: chainOf(dst), transport: http(dst.url, { retryCount: 0 }), account: privateKeyToAccount(submitterKey) });
  let cursor = BigInt(fromBlock);
  const stats = { delivered: 0, skipped: 0, refused: 0, notAllowed: 0 };
  // F-1: messages that failed (target reverted, validators offline...) wait here and are
  // retried on later polls. They never block the messages behind them.
  const pending = new Map(); // id -> { txHash, logIndex }
  // F-2: optional allow-list. Delivering costs the relayer gas on the destination chain;
  // without a list, anyone could make it pay for messages to any contract.
  const allowed = allowedTargets && allowedTargets.map((a) => getAddress(a));

  async function deliver(txHash, logIndex) {
    // ask validators; keep going until `threshold` agree (one being offline or lying is fine)
    const sigs = [];
    let attested;
    for (const v of validators) {
      try {
        const a = await v.attest(txHash, logIndex);
        if (attested && a.id !== attested.id) continue;
        attested = attested || a;
        sigs.push({ signer: getAddress(v.address), signature: a.signature });
      } catch (e) { log(`validator ${v.address.slice(0, 8)} refused: ${e.message}`); }
      if (sigs.length >= threshold) break;
    }
    if (!attested || sigs.length < threshold) throw new Error("not enough validators agreed");
    const id = attested.id;
    if (await dstClient.readContract({ address: dstMessenger, abi: MESSENGER_ABI, functionName: "processed", args: [id] })) {
      stats.skipped++;
      return { id, status: "already delivered" };
    }
    sigs.sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1)); // the contract wants ascending signers
    const args = [attested.message, sigs.map((s) => s.signature)];
    // simulate first: never pay for a delivery that would fail
    const { request } = await dstClient.simulateContract({ address: dstMessenger, abi: MESSENGER_ABI, functionName: "receiveMessage", args, account: wallet.account });
    const hash = await wallet.writeContract(request);
    const receipt = await dstClient.waitForTransactionReceipt({ hash, pollingInterval: 50 });
    if (receipt.status !== "success") throw new Error("delivery reverted");
    stats.delivered++;
    return { id, status: "delivered", hash, gasUsed: receipt.gasUsed };
  }

  async function attempt(id, txHash, logIndex) {
    try {
      const r = await deliver(txHash, logIndex);
      pending.delete(id);
      return r;
    } catch (e) {
      stats.refused++;
      pending.set(id, { txHash, logIndex });
      return { id, status: "failed", reason: e.shortMessage || e.message };
    }
  }

  return {
    stats,
    pending,
    get cursor() { return cursor; },
    /** Retry up to `maxRetriesPerPoll` failed messages, then deliver every new MessageSent
     *  event with enough confirmations. Returns one result per message tried. */
    async poll() {
      const results = [];
      for (const [id, p] of [...pending].slice(0, maxRetriesPerPoll)) results.push(await attempt(id, p.txHash, p.logIndex));
      const head = await srcClient.getBlockNumber();
      const safe = head - BigInt(confirmations) + 1n; // newest block with enough confirmations
      if (safe < cursor) return results;
      const logs = await srcClient.getLogs({ address: srcMessenger, event: MESSAGE_SENT, fromBlock: cursor, toBlock: safe });
      for (const l of logs) {
        if (allowed && !allowed.some((a) => isAddressEqual(a, l.args.message.target))) {
          stats.notAllowed++;
          results.push({ id: l.args.id, status: "not paid for (target not allowed)" });
          continue;
        }
        if (pending.has(l.args.id)) continue;
        results.push(await attempt(l.args.id, l.transactionHash, l.logIndex));
      }
      cursor = safe + 1n;
      return results;
    },
    deliver,
  };
}

module.exports = { MESSENGER_ABI, hashMessage, createValidator, createRelayer, clientFor, parseAbiItem };
