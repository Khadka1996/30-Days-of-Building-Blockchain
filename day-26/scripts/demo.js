// Day 26 demo: two local chains, a cost comparison, messages both ways, and attacks.
//   npm run demo      (starts its own L1 + L2, prints everything, stops them)
const { ethers } = require("ethers");
const { startChains, devWallet } = require("../lib/chains");
const { deployBoth, deployContract } = require("../lib/deploy");
const { createValidator, createRelayer, hashMessage } = require("../relayer/relayer");
const { measureCosts, formatCosts } = require("../lib/costs");

const enc = (t) => ethers.AbiCoder.defaultAbiCoder().encode(["string"], [t]);
const mine = (chain, n) => chain.provider.send("hardhat_mine", ["0x" + n.toString(16)]);

async function main() {
  const chains = await startChains({ l1Port: Number(process.env.L1_PORT || 8545), l2Port: Number(process.env.L2_PORT || 8546) });
  try {
    const env = await deployBoth(chains);
    console.log(`L1: chain ${chains.l1.chainId} on ${chains.l1.url}   L2: chain ${chains.l2.chainId} on ${chains.l2.url}`);
    console.log(`Validators: ${env.validators.length}, threshold ${env.threshold} of ${env.validators.length}\n`);

    // ---- 1. costs
    console.log("1) Same action on L1 and on the L2-style chain (real gas and real signed bytes):");
    console.log(formatCosts(await measureCosts(env)), "\n");

    // ---- 2. messages both ways
    const submitterKey = devWallet(9, chains.l1.provider).privateKey;
    const relay = (from, to) => createRelayer({
      src: chains[from], dst: chains[to], srcMessenger: env[from].address.messenger, dstMessenger: env[to].address.messenger,
      threshold: env.threshold, submitterKey, confirmations: 2,
      validators: env.validators.map((v) => createValidator({ privateKey: v.privateKey, src: chains[from], srcMessenger: env[from].address.messenger, dstChainId: chains[to].chainId, dstMessenger: env[to].address.messenger, confirmations: 2 })),
    });
    const up = relay("l1", "l2"), down = relay("l2", "l1");
    const user1 = devWallet(1, chains.l1.provider), user2 = devWallet(1, chains.l2.provider);
    const sent = await (await env.l1.messenger.connect(user1).sendMessage(chains.l2.chainId, env.l2.address.todo, enc("Pay the electricity bill"))).wait();
    await (await env.l2.messenger.connect(user2).sendMessage(chains.l1.chainId, env.l1.address.todo, enc("Book bus to Pokhara"))).wait();
    const ourId = sent.logs.map((l) => { try { return env.l1.messenger.interface.parseLog(l); } catch { return null; } }).find(Boolean).args.id;
    // (the cost test above also sent one message, long confirmed: the relayer delivers that one now)
    const early = (await up.poll()).filter((r) => r.id === ourId).length;
    await mine(chains.l1, 1); await mine(chains.l2, 1);
    const d1 = (await up.poll()).find((r) => r.id === ourId); const [d2] = await down.poll();
    console.log("2) Cross-chain messages (relayer waits for 2 confirmations, 2 of 3 validators sign):");
    console.log(`   our L1 → L2 message before 2 confirmations: ${early} delivered (too early: could still be reorganised)`);
    console.log(`   L1 → L2 "${(await env.l2.todo.getTasks(31337, user1.address))[0].text}"  ${d1.status}, ${d1.gasUsed} gas on L2`);
    console.log(`   L2 → L1 "${(await env.l1.todo.getTasks(31338, user2.address))[0].text}"  ${d2.status}, ${d2.gasUsed} gas on L1\n`);

    // ---- 3. attacks
    const iface = env.l1.messenger.interface;
    const ev = sent.logs.map((l) => { try { return iface.parseLog(l); } catch { return null; } }).find(Boolean);
    const m = ev.args.message.toObject();
    const msg = { ...m, data: m.data };
    const sign = async (message, vs) => {
      const id = hashMessage(message);
      const sorted = [...vs].sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
      return Promise.all(sorted.map((v) => v.signMessage(ethers.getBytes(id))));
    };
    const sigs = await sign(msg, env.validators.slice(0, 2));
    const attacker = { l1: devWallet(2, chains.l1.provider), l2: devWallet(2, chains.l2.provider) };
    const twin = await deployContract(env.l2.owner, "Messenger", [env.validators.map((v) => v.address), 2, env.l2.owner.address]);
    await (await twin.setRemote(31337, env.l1.address.messenger)).wait();
    const fake = await deployContract(attacker.l1, "test/FakeMessenger");
    const fakeMsg = { ...msg, nonce: 99n, sender: attacker.l1.address };
    const fakeRc = await (await fake.fake(fakeMsg, hashMessage(fakeMsg))).wait();
    await mine(chains.l1, 3);
    const [v0] = env.validators.map((v) => createValidator({ privateKey: v.privateKey, src: chains.l1, srcMessenger: env.l1.address.messenger, dstChainId: 31338, dstMessenger: env.l2.address.messenger }));

    const attacks = [
      ["Replay the delivered message on L2", () => env.l2.messenger.connect(attacker.l2).receiveMessage.staticCall(msg, sigs)],
      ["Replay it on L1 (cross-chain replay)", () => env.l1.messenger.connect(attacker.l1).receiveMessage.staticCall(msg, sigs)],
      ["Replay it on a 2nd Messenger on L2", () => twin.connect(attacker.l2).receiveMessage.staticCall(msg, sigs)],
      ["Change the text after signing", () => env.l2.messenger.receiveMessage.staticCall({ ...msg, nonce: 50n, data: enc("Send me your savings") }, sigs)],
      ["Deliver with 1 stolen validator key", async () => env.l2.messenger.receiveMessage.staticCall({ ...msg, nonce: 51n }, await sign({ ...msg, nonce: 51n }, [env.validators[0]]))],
      ["Same validator signs twice", async () => { const [s] = await sign({ ...msg, nonce: 52n }, [env.validators[0]]); return env.l2.messenger.receiveMessage.staticCall({ ...msg, nonce: 52n }, [s, s]); }],
      ["Message from an unknown chain", async () => { const x = { ...msg, srcChainId: 999n }; return env.l2.messenger.receiveMessage.staticCall(x, await sign(x, env.validators.slice(0, 2))); }],
      ["Fake MessageSent event (attacker contract)", () => v0.attest(fakeRc.hash, fakeRc.logs[0].index)],
      ["Call the to-do app's onMessage directly", () => env.l2.todo.connect(attacker.l2).onMessage.staticCall(31337, user1.address, enc("x"))],
    ];
    console.log("3) Attacks:");
    let refused = 0;
    for (const [name, run] of attacks) {
      let reason = "ACCEPTED (bug!)";
      try { await run(); } catch (e) { refused++; reason = e.revert?.name || e.shortMessage || e.message; }
      console.log(`   ${name.padEnd(44)} refused: ${reason}`);
    }
    console.log(`   ${refused} of ${attacks.length} refused`);
    if (refused !== attacks.length) process.exitCode = 1;
  } finally {
    await chains.stop();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
