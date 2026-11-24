// Shared test setup: the in-process Hardhat chain, viem clients over it, the
// contracts, a relayer server, and a helper to sign ForwardRequests.
const { ethers, network, artifacts } = require("hardhat");
const { createPublicClient, createWalletClient, custom, encodeFunctionData } = require("viem");
const { createRelayer, TYPES } = require("../relayer/server");

const CHAIN_ID = 31337;
// The in-process Hardhat provider throws reverts without the JSON-RPC error code a
// real node sends (3 = "execution reverted"), so add it: viem can then decode them.
const transport = custom({
  async request({ method, params }) {
    try { return await network.provider.request({ method, params }); } catch (e) {
      if (typeof e.data === "string" && e.code === undefined) throw Object.assign(new Error(e.message), { code: 3, data: e.data });
      throw e;
    }
  },
}, { retryCount: 0 });
const publicClient = createPublicClient({ transport, cacheTime: 0, pollingInterval: 20 });
const walletClient = createWalletClient({ transport });

async function chainNow() {
  return Number((await ethers.provider.getBlock("latest")).timestamp);
}

async function deploy() {
  const signers = await ethers.getSigners();
  const forwarder = await ethers.deployContract("Forwarder");
  const fwd = await forwarder.getAddress();
  const todo = await ethers.deployContract("GaslessTodoList", [fwd]);
  const otherApp = await ethers.deployContract("GaslessTodoList", [fwd]); // trusts the forwarder, but not ours to pay for
  const info = async (c, name) => ({ address: await c.getAddress(), abi: (await artifacts.readArtifact(name)).abi });
  return {
    signers, forwarder, todo, otherApp,
    forwarderInfo: await info(forwarder, "Forwarder"),
    todoInfo: await info(todo, "GaslessTodoList"),
  };
}

/** A brand-new user with 0 ETH: that is the whole point of gasless. */
function newUser() {
  return ethers.Wallet.createRandom().connect(ethers.provider);
}

function domain(forwarderAddress, chainId = CHAIN_ID) {
  return { name: "Day25Forwarder", version: "1", chainId, verifyingContract: forwarderAddress };
}

/** Build and sign a ForwardRequest. `over` replaces fields after signing defaults are filled. */
async function signRequest(env, user, { fn = "addTask", args = ["Buy momo"], to, value = 0n, gas = 200_000n, nonce, deadline, chainId, verifyingContract, data } = {}) {
  const target = to || env.todoInfo.address;
  const req = {
    from: user.address,
    to: target,
    value,
    gas,
    nonce: nonce ?? (await env.forwarder.nonces(user.address)),
    deadline: deadline ?? (await chainNow()) + 600,
    data: data ?? encodeFunctionData({ abi: env.todoInfo.abi, functionName: fn, args }),
  };
  const signature = await user.signTypedData(domain(verifyingContract || env.forwarderInfo.address, chainId), TYPES, req);
  return { req, signature };
}

/** The JSON a browser would POST (numbers as decimal strings). */
function toJson({ req, signature }) {
  return {
    signature,
    request: { ...req, value: req.value.toString(), gas: req.gas.toString(), nonce: req.nonce.toString(), deadline: req.deadline.toString() },
  };
}

async function startRelayer(env, opts = {}) {
  const relayer = env.signers[9].address;
  const app = createRelayer({
    publicClient, walletClient, relayer, chainId: CHAIN_ID,
    forwarder: env.forwarderInfo, todo: env.todoInfo, now: chainNow, ...opts,
  });
  const port = await app.listen(0);
  app.base = `http://127.0.0.1:${port}`;
  app.relayerAddress = relayer;
  app.post = async (body, headers = {}) => {
    const res = await fetch(`${app.base}/api/relay`, {
      method: "POST", headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return app;
}

const snapshot = () => network.provider.send("evm_snapshot");
const revert = (id) => network.provider.send("evm_revert", [id]);
const txCount = (addr) => ethers.provider.getTransactionCount(addr);

module.exports = { CHAIN_ID, publicClient, walletClient, chainNow, deploy, newUser, domain, signRequest, toJson, startRelayer, snapshot, revert, txCount };
