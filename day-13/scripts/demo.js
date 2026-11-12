// Day 13 demo: one English auction and one Dutch auction on the local Hardhat network,
// plus the refund denial-of-service attack against a naive auction.
// Run: npx hardhat run scripts/demo.js
const { ethers, network } = require("hardhat");

const ETH = (n) => ethers.parseEther(String(n));
const fmt = (wei) => ethers.formatEther(wei);
const HOUR = 3600;
const DAY = 24 * HOUR;
const row = (label, value) => console.log(label.padEnd(46) + value);

async function setTime(t) { await network.provider.send("evm_setNextBlockTimestamp", [Number(t)]); }
async function now() { return (await ethers.provider.getBlock("latest")).timestamp; }
async function gas(txPromise) { return (await (await txPromise).wait()).gasUsed; }
async function reason(p, c) {
  try { await p; return "went through (bad!)"; } catch (e) {
    const data = e.data || e.error?.data;
    try { const p = c.interface.parseError(data); return "reverted with " + (p.name === "Error" ? `"${p.args[0]}"` : p.name); } catch { return "reverted: " + (e.reason || e.shortMessage || e.message).slice(0, 40); }
  }
}

async function main() {
  const [seller, ram, sita, hari] = await ethers.getSigners();
  const art = await ethers.deployContract("HimalArt", [2]);

  console.log("=== English auction: Himal Art #1, reserve 1 ETH, 24 hours ===");
  const en = await ethers.deployContract("EnglishAuction", [await art.getAddress(), 1, ETH(1), DAY]);
  await art.approve(await en.getAddress(), 1);
  await en.start();
  const bad = await ethers.deployContract("RejectingBidder");
  await bad.bid(await en.getAddress(), { value: ETH(1) });
  row("Bad bidder (rejects ETH refunds) bids", "1.0 ETH");
  const g1 = await gas(en.connect(ram).bid({ value: ETH("1.5") }));
  row("Ram outbids it (still works)", "1.5 ETH, gas used: " + g1);
  row("Sita tries 1.55 ETH (needs +5%)", await reason(en.connect(sita).bid({ value: ETH("1.55") }), en));
  await en.connect(sita).bid({ value: ETH(2) });
  row("Sita bids", "2.0 ETH");
  const end1 = await en.endAt();
  await setTime(end1 - 30n);
  await en.connect(hari).bid({ value: ETH("2.1") });
  const end2 = await en.endAt();
  row("Hari snipes 30 s before the end", "2.1 ETH, end moved +" + (end2 - end1) + " s");
  await setTime((await now()) + 300);
  await en.connect(sita).bid({ value: ETH(3) });
  row("Sita answers 5 minutes later", "3.0 ETH");
  await setTime(await en.endAt());
  await en.end();
  row("Winner", (await art.ownerOf(1)) === sita.address ? "Sita, for 3.0 ETH" : "?");
  row("Bad bidder's withdraw", await reason(bad.withdrawFrom(await en.getAddress()), en));
  row("  (only hurts itself, still owed)", fmt(await en.pendingReturns(await bad.getAddress())) + " ETH");
  await en.connect(seller).withdraw();
  await en.connect(ram).withdraw();
  await en.connect(hari).withdraw();
  await en.connect(sita).withdraw(); // her earlier 2 ETH bid
  row("Seller, Ram, Sita and Hari withdraw", "done");
  row("Left in contract (bad bidder's 1 ETH)", fmt(await ethers.provider.getBalance(await en.getAddress())) + " ETH");

  console.log("\n=== The naive auction that pays refunds immediately ===");
  const naive = await ethers.deployContract("PushRefundAuction");
  const bad2 = await ethers.deployContract("RejectingBidder");
  await bad2.bid(await naive.getAddress(), { value: ETH(1) });
  row("Bad bidder bids 1 ETH, then Ram bids 5 ETH", await reason(naive.connect(ram).bid({ value: ETH(5) }), naive));
  row("Result", "auction frozen, bad bidder wins with 1 ETH");

  console.log("\n=== Dutch auction: Himal Art #2, 10 ETH falling to 1 ETH over 24 hours ===");
  const du = await ethers.deployContract("DutchAuction", [await art.getAddress(), 2, ETH(10), ETH(1), DAY]);
  await art.approve(await du.getAddress(), 2);
  await du.start();
  const t0 = await du.startAt();
  row("Price at the start", fmt(await du.currentPrice()) + " ETH");
  for (const h of [6, 12, 18]) {
    await setTime(t0 + BigInt(h * HOUR));
    await network.provider.send("evm_mine");
    row(`Price after ${h} hours`, fmt(await du.currentPrice()) + " ETH");
  }
  row("Seller tries to cancel in front of a buyer", await reason(du.cancel(), du));
  await setTime(t0 + BigInt(20 * HOUR));
  const before = await ethers.provider.getBalance(ram.address);
  const rc = await (await du.connect(ram).buy({ value: ETH(5) })).wait();
  const paid = before - (await ethers.provider.getBalance(ram.address)) - rc.gasUsed * rc.gasPrice;
  row("Ram buys at 20 hours, sends 5 ETH", "pays " + fmt(paid) + " ETH, change back, gas used: " + rc.gasUsed);
  row("Sita tries to buy too", await reason(du.connect(sita).buy({ value: ETH(5) }), du));
  await du.withdraw();
  row("Seller withdraws", fmt(await du.soldPrice()) + " ETH");
  row("Left in contract", fmt(await ethers.provider.getBalance(await du.getAddress())) + " ETH");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
