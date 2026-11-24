// A user with 0 ETH uses the to-do list through the relayer, then 9 attacks on
// the relayer and the forwarder. Run: npm run demo
const { ethers } = require("hardhat");
const { encodeFunctionData } = require("viem");
const h = require("../test/helpers");

async function main() {
  const env = await h.deploy();
  const app = await h.startRelayer(env);
  const user = h.newUser();
  const mallory = h.newUser();
  const relayerStart = await ethers.provider.getBalance(app.relayerAddress);
  const line = (label, r) => console.log(`${label.padEnd(46)} ${String(r.status).padEnd(4)} ${r.body.error || `relayed, gas ${r.body.gasUsed}`}`);

  console.log(`User ${user.address} has ${ethers.formatEther(await ethers.provider.getBalance(user.address))} ETH\n`);
  const first = await h.signRequest(env, user, { args: ["Pay electricity bill"] });
  line("User adds 'Pay electricity bill' (0 ETH)", await app.post(h.toJson(first)));
  line("User adds 'Buy momo for the team'", await app.post(h.toJson(await h.signRequest(env, user, { args: ["Buy momo for the team"] }))));
  line("User completes task 1", await app.post(h.toJson(await h.signRequest(env, user, { fn: "completeTask", args: [1n] }))));
  const txAfterGood = await h.txCount(app.relayerAddress);

  console.log("\nAttacks:");
  let refused = 0;
  const attack = async (label, body) => { const r = await app.post(body); line(label, r); if (r.status !== 200) refused++; };
  await attack("Replay the user's first request", h.toJson(first));
  const m = await h.signRequest(env, mallory, { args: ["Mallory was here"] });
  await attack("Mallory signs, claims to be the user", h.toJson({ req: { ...m.req, from: user.address }, signature: m.signature }));
  const t = await h.signRequest(env, user, { args: ["original"] });
  await attack("Change the task text after signing", h.toJson({ req: { ...t.req, data: encodeFunctionData({ abi: env.todoInfo.abi, functionName: "addTask", args: ["changed"] }) }, signature: t.signature }));
  await attack("Signed for another chain (ID 1)", h.toJson(await h.signRequest(env, user, { chainId: 1 })));
  await attack("Make the relayer pay for another app", h.toJson(await h.signRequest(env, user, { to: await env.otherApp.getAddress() })));
  await attack("Make the relayer send 1 ETH", h.toJson(await h.signRequest(env, user, { value: ethers.parseEther("1") })));
  await attack("Ask for 10,000,000 gas", h.toJson(await h.signRequest(env, user, { gas: 10_000_000n })));
  await attack("Signature valid for 1 year", h.toJson(await h.signRequest(env, user, { deadline: (await h.chainNow()) + 365 * 86400 })));
  await attack("Request that would revert (empty task)", h.toJson(await h.signRequest(env, user, { args: [""] })));

  const tasks = await env.todo.getTasks(user.address);
  const spent = relayerStart - (await ethers.provider.getBalance(app.relayerAddress));
  console.log(`\nUser's tasks: ${tasks.map((x) => `${x.completed ? "[x]" : "[ ]"} ${x.text}`).join(" · ")}`);
  console.log(`User's ETH: ${ethers.formatEther(await ethers.provider.getBalance(user.address))} · relayer paid ${ethers.formatEther(spent)} ETH for 3 transactions`);
  console.log(`Transactions sent for the attacks: ${(await h.txCount(app.relayerAddress)) - txAfterGood}`);
  console.log(`3 gasless actions done · ${refused} of 9 attacks refused`);
  await app.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
