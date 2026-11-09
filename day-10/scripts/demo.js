// Demo on the local Hardhat network: 1,000 addresses, one root on-chain, real claims and real cheating.
const { ethers } = require("hardhat");
const { time, setBalance } = require("@nomicfoundation/hardhat-network-helpers");
const { buildAirdrop } = require("../lib/airdrop");

const HIM = (n) => ethers.parseEther(String(n));
const say = (label, value) => console.log(label.padEnd(46), value);
const reason = async (p) => p.then(() => "SUCCEEDED (bug!)").catch((e) => `reverted with ${(e.message.match(/custom error '(\w+)/) || [])[1] || e.message}`);

async function main() {
  const [treasury] = await ethers.getSigners();
  const wallets = Array.from({ length: 1000 }, (_, i) => new ethers.Wallet(ethers.id(`day10-user-${i}`), ethers.provider));
  const ad = buildAirdrop(wallets.map((w) => ({ address: w.address, amount: HIM(100) })));
  const proofLengths = wallets.map((_, i) => ad.proofFor(i).length);
  say("Addresses on the list", wallets.length.toLocaleString("en-US"));
  say("Total airdrop", `${ethers.formatEther(ad.total)} HIM`);
  say("Stored on-chain", `1 hash: ${ad.root}`);
  say("Hashes in a proof", `${Math.min(...proofLengths)} to ${Math.max(...proofLengths)}`);

  const token = await ethers.deployContract("HimalToken");
  const drop = await ethers.deployContract("MerkleAirdrop", [await token.getAddress(), ad.root, treasury.address, ad.total, 30 * 86400]);
  const addr = await drop.getAddress();
  const deployed = (await drop.deploymentTransaction().wait()).gasUsed;
  await (await token.approve(addr, ad.total)).wait();
  await (await drop.fund()).wait();
  say("Deploy the airdrop (any list size)", `gas used: ${deployed}`);

  let totalClaimGas = 0n;
  const claimers = 100;
  for (let i = 0; i < claimers; i++) {
    await setBalance(wallets[i].address, HIM(1));
    const r = await (await drop.connect(wallets[i]).claim(i, HIM(100), ad.proofFor(i))).wait();
    totalClaimGas += r.gasUsed;
  }
  say(`Average claim (first ${claimers} people)`, `gas used: ${totalClaimGas / BigInt(claimers)}`);
  say("Wallet 0 balance", `${ethers.formatEther(await token.balanceOf(wallets[0].address))} HIM`);

  console.log("\n--- trying to cheat ---");
  const eve = wallets[999];
  await setBalance(eve.address, HIM(1));
  say("Claim a second time", await reason(drop.connect(wallets[0]).claim(0, HIM(100), ad.proofFor(0))));
  say("Copy someone else's proof", await reason(drop.connect(eve).claim(200, HIM(100), ad.proofFor(200))));
  say("Ask for 1 wei more", await reason(drop.connect(eve).claim(999, HIM(100) + 1n, ad.proofFor(999))));
  say("Sweep before the deadline", await reason(drop.sweep()));

  console.log("\n--- the expensive way: store all 1,000 on-chain ---");
  const store = await ethers.deployContract("StoreEveryAddress");
  let storeGas = (await store.deploymentTransaction().wait()).gasUsed;
  const addrs = wallets.map((w) => w.address);
  for (let i = 0; i < 1000; i += 250) {
    const r = await (await store.add(addrs.slice(i, i + 250), Array(250).fill(HIM(100)))).wait();
    storeGas += r.gasUsed;
  }
  say("Store every address", `gas used: ${storeGas}`);
  say("Merkle airdrop setup", `gas used: ${deployed}`);
  say("Setup is cheaper by", `${(Number(storeGas) / Number(deployed)).toFixed(1)} times`);

  await time.increaseTo((await drop.deadline()) + 1n);
  await (await drop.sweep()).wait();
  say("\nLeft in contract after the sweep", `${ethers.formatEther(await token.balanceOf(addr))} HIM`);
}

main().catch((e) => { console.error(e); process.exit(1); });
