// Demo on the local Hardhat network: a 100-token collection sells out through
// the allowlist sale, the public sale and the team reserve, while every cheat fails.
const { ethers } = require("hardhat");
const { setBalance } = require("@nomicfoundation/hardhat-network-helpers");
const { buildAllowlist } = require("../lib/allowlist");

const ETH = (n) => ethers.parseEther(String(n));
const say = (label, value) => console.log(label.padEnd(46), value);
const reason = async (p) =>
  p.then(() => "SUCCEEDED (bug!)").catch((e) => `reverted with ${(e.message.match(/custom error '(\w+)/) || [])[1] || e.message}`);

const MAX = 100, RESERVE = 10, AL_PRICE = ETH("0.01"), PUB_PRICE = ETH("0.02");

async function main() {
  const [owner, treasury] = await ethers.getSigners();
  const wallet = (tag, i) => new ethers.Wallet(ethers.id(`day11-${tag}-${i}`), ethers.provider);
  const listed = Array.from({ length: 30 }, (_, i) => wallet("allowlist", i));
  const buyers = Array.from({ length: 10 }, (_, i) => wallet("public", i));
  const eve = wallet("eve", 0);
  for (const w of [...listed, ...buyers, eve]) await setBalance(w.address, ETH(1));

  const al = buildAllowlist(listed.map((w) => w.address));
  const nft = await ethers.deployContract("HimalPeaks", [owner.address, treasury.address, MAX, RESERVE, AL_PRICE, PUB_PRICE, al.root, "ipfs://bafy-himal-peaks/"]);
  const addr = await nft.getAddress();
  say("Collection", `${await nft.name()} (${await nft.symbol()}), max supply ${MAX}`);
  say("Team reserve", `${RESERVE} tokens, kept aside from the sale`);
  say("Allowlist", `${listed.length} wallets, 1 hash on-chain`);

  // --- allowlist sale
  await (await nft.setPhase(1)).wait();
  let gas = 0n;
  for (const w of listed) {
    const r = await (await nft.connect(w).allowlistMint(2, al.proofFor(w.address), { value: AL_PRICE * 2n })).wait();
    gas += r.gasUsed;
  }
  say("Allowlist sale", `${await nft.totalMinted()} minted, 2 each at 0.01 ETH`);
  say("Average allowlist mint of 2", `gas used: ${gas / BigInt(listed.length)}`);

  console.log("\n--- trying to cheat in the allowlist sale ---");
  say("Wallet not on the list", await reason(nft.connect(eve).allowlistMint(1, al.proofFor(listed[0].address), { value: AL_PRICE })));
  say("Listed wallet asks for a 3rd", await reason(nft.connect(listed[0]).allowlistMint(1, al.proofFor(listed[0].address), { value: AL_PRICE })));
  say("Public mint before the public sale", await reason(nft.connect(eve).publicMint(1, { value: PUB_PRICE })));

  // --- public sale
  await (await nft.setPhase(2)).wait();
  gas = 0n;
  for (const w of buyers) gas += (await (await nft.connect(w).publicMint(3, { value: PUB_PRICE * 3n })).wait()).gasUsed;
  console.log(); say("Public sale", `${await nft.totalMinted()} minted in total, sale left: ${await nft.saleRemaining()}`);
  say("Average public mint of 3", `gas used: ${gas / BigInt(buyers.length)}`);

  console.log("\n--- trying to cheat in the public sale ---");
  say("Ask for 4 in one wallet", await reason(nft.connect(listed[1]).publicMint(4, { value: PUB_PRICE * 4n })));
  say("Pay 1 wei too much", await reason(nft.connect(listed[1]).publicMint(1, { value: PUB_PRICE + 1n })));
  say("Mint after the sale sold out", await reason(nft.connect(eve).publicMint(1, { value: PUB_PRICE })));

  // --- team reserve
  await (await nft.teamMint(owner.address, RESERVE)).wait();
  console.log(); say("Team mint", `${RESERVE} tokens, total now ${await nft.totalMinted()} / ${MAX}`);
  say("Team asks for 1 more", await reason(nft.teamMint(owner.address, 1)));
  say("Token 100 metadata", await nft.tokenURI(100));

  // --- money
  const raised = await ethers.provider.getBalance(addr);
  console.log(); say("Raised", `${ethers.formatEther(raised)} ETH (60 x 0.01 + 30 x 0.02)`);
  say("Stranger tries withdraw()", await reason(nft.connect(eve).withdraw()));
  const before = await ethers.provider.getBalance(treasury.address);
  await (await nft.withdraw()).wait();
  say("Treasury received", `${ethers.formatEther((await ethers.provider.getBalance(treasury.address)) - before)} ETH`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
