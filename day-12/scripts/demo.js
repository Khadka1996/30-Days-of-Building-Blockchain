// Day 12 demo: list, buy, resell with royalties, a stale-listing attack, and a greedy royalty.
const { ethers } = require("hardhat");

const ETH = (n) => ethers.parseEther(String(n));
const fmt = (wei) => `${ethers.formatEther(wei)} ETH`;
const row = (label, value) => console.log(label.padEnd(46) + value);
const DAY = 24 * 60 * 60;

async function main() {
  const [ram, sita, hari, artist, eve] = await ethers.getSigners();
  const market = await ethers.deployContract("HimalMarket");
  const prints = await ethers.deployContract("HimalPrints", [3, artist.address, 500]);
  const m = market.target;
  const p = prints.target;

  console.log("=== Himal Prints #1, artist royalty 5% ===");
  await prints.approve(m, 1);
  let tx = await market.list(p, 1, ETH(1), 7 * DAY);
  row("Ram lists #1 (NFT stays in his wallet)", `1.0 ETH, gas used: ${(await tx.wait()).gasUsed}`);
  tx = await market.connect(sita).buy(p, 1, ETH(1), { value: ETH(1) });
  row("Sita buys #1", `1.0 ETH, gas used: ${(await tx.wait()).gasUsed}`);
  row("  Ram is owed", fmt(await market.proceeds(ram.address)));
  row("  Artist is owed", fmt(await market.proceeds(artist.address)));

  await prints.connect(sita).approve(m, 1);
  await market.connect(sita).list(p, 1, ETH(4), 7 * DAY);
  await market.connect(hari).buy(p, 1, ETH(4), { value: ETH(4) });
  row("Sita resells #1 to Hari", "4.0 ETH");
  row("  Sita is owed", fmt(await market.proceeds(sita.address)));
  row("  Artist is owed (both sales)", fmt(await market.proceeds(artist.address)));

  console.log("\n=== Front-running: the seller raises the price while Hari waits ===");
  await prints.approve(m, 2);
  await market.list(p, 2, ETH(1), 7 * DAY);
  await market.updatePrice(p, 2, ETH(5));
  try {
    await market.connect(hari).buy(p, 2, ETH(1), { value: ETH(5) });
  } catch (e) {
    row("Hari's buy (expected 1 ETH)", "reverted with PriceChanged, paid nothing");
  }

  console.log("\n=== Selling an NFT you no longer own ===");
  const naive = await ethers.deployContract("NaiveMarket");
  await prints.setApprovalForAll(naive.target, true);
  await naive.list(p, 3, ETH(1));
  await prints.setApprovalForAll(m, true);
  await market.list(p, 3, ETH(1), 7 * DAY);
  await prints.transferFrom(ram.address, eve.address, 3);
  await prints.connect(eve).setApprovalForAll(naive.target, true);
  await prints.connect(eve).setApprovalForAll(m, true);
  row("Ram gives #3 to Eve; his old listings remain", "");
  try {
    await market.connect(hari).buy(p, 3, ETH(1), { value: ETH(1) });
  } catch (e) {
    row("HimalMarket: Hari buys Ram's old listing", "reverted with StaleListing");
  }
  row("  isBuyable(#3)", String(await market.isBuyable(p, 3)));
  await naive.connect(hari).buy(p, 3, { value: ETH(1) });
  row("Naive market: same purchase", `Eve lost #3, owner now Hari: ${(await prints.ownerOf(3)) === hari.address}`);

  console.log("\n=== A collection that asks for a 100% royalty ===");
  const greedy = await ethers.deployContract("GreedyNFT", [eve.address, 10_000]);
  await greedy.approve(m, 1);
  await market.list(greedy.target, 1, ETH(2), DAY);
  const q = await market.quote(greedy.target, 1, ETH(2));
  row("Price 2 ETH, royalty asked 100%", `royalty paid ${fmt(q.royalty)} (capped at 10%)`);
  row("  Seller gets", fmt(q.sellerGets));

  console.log("\n=== Withdrawals ===");
  for (const [name, who] of [["Ram", ram], ["Sita", sita], ["Artist", artist]]) {
    const owed = await market.proceeds(who.address);
    if (owed > 0n) {
      await market.connect(who).withdraw();
      row(`${name} withdraws`, fmt(owed));
    }
  }
  row("Left in the market", fmt(await ethers.provider.getBalance(m)));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
