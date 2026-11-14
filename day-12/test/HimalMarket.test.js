const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const fc = require("fast-check");

const ETH = (n) => ethers.parseEther(String(n));
const DAY = 24 * 60 * 60;

async function deploy() {
  const [ram, sita, hari, artist, eve] = await ethers.getSigners();
  const market = await ethers.deployContract("HimalMarket");
  // Ram deploys the collection and owns tokens 1..5. The artist earns 5% on every sale.
  const prints = await ethers.deployContract("HimalPrints", [5, artist.address, 500]);
  const m = await market.getAddress();
  const p = await prints.getAddress();
  return { ram, sita, hari, artist, eve, market, prints, m, p };
}

async function listed() {
  const f = await deploy();
  await f.prints.approve(f.m, 1);
  await f.market.list(f.p, 1, ETH(1), 7 * DAY);
  return f;
}

describe("HimalPrints (ERC-721 + ERC-2981)", function () {
  it("mints to the deployer and reports a 5% royalty to the artist", async function () {
    const { ram, artist, prints } = await loadFixture(deploy);
    expect(await prints.ownerOf(5)).to.equal(ram.address);
    const [r, amount] = await prints.royaltyInfo(1, ETH(1));
    expect(r).to.equal(artist.address);
    expect(amount).to.equal(ETH(0.05));
    expect(await prints.supportsInterface("0x2a55205a")).to.equal(true); // ERC-2981
    expect(await prints.supportsInterface("0x80ac58cd")).to.equal(true); // ERC-721
  });
});

describe("HimalMarket — listing", function () {
  it("lists an approved NFT and emits Listed", async function () {
    const { ram, market, prints, m, p } = await loadFixture(deploy);
    await prints.approve(m, 1);
    await expect(market.list(p, 1, ETH(1), DAY)).to.emit(market, "Listed");
    const l = await market.listings(p, 1);
    expect(l.seller).to.equal(ram.address);
    expect(l.price).to.equal(ETH(1));
    expect(await market.isBuyable(p, 1)).to.equal(true);
  });

  it("setApprovalForAll also counts as approval", async function () {
    const { market, prints, m, p } = await loadFixture(deploy);
    await prints.setApprovalForAll(m, true);
    await market.list(p, 2, ETH(2), DAY);
    expect(await market.isBuyable(p, 2)).to.equal(true);
  });

  it("rejects a zero price, bad durations, non-owners and missing approval", async function () {
    const { sita, market, prints, m, p } = await loadFixture(deploy);
    await expect(market.list(p, 1, 0, DAY)).to.be.revertedWithCustomError(market, "PriceZero");
    await expect(market.list(p, 1, ETH(1), 60 * 59)).to.be.revertedWithCustomError(market, "BadDuration");
    await expect(market.list(p, 1, ETH(1), 181 * DAY)).to.be.revertedWithCustomError(market, "BadDuration");
    await expect(market.connect(sita).list(p, 1, ETH(1), DAY)).to.be.revertedWithCustomError(market, "NotOwner");
    await expect(market.list(p, 1, ETH(1), DAY)).to.be.revertedWithCustomError(market, "NotApproved");
    await prints.approve(m, 1);
    await expect(market.list(p, 1, ETH(1), 60 * 60)).to.not.be.reverted; // 1 hour is the minimum
    await expect(market.list(p, 1, ETH(1), 180 * DAY)).to.not.be.reverted; // 180 days is the maximum
  });

  it("only the seller can change the price, and only while they still own it", async function () {
    const { ram, sita, market, prints, p } = await loadFixture(listed);
    await expect(market.connect(sita).updatePrice(p, 1, ETH(2))).to.be.revertedWithCustomError(market, "NotSeller");
    await expect(market.updatePrice(p, 1, 0)).to.be.revertedWithCustomError(market, "PriceZero");
    await expect(market.updatePrice(p, 2, ETH(2))).to.be.revertedWithCustomError(market, "NotListed");
    await expect(market.updatePrice(p, 1, ETH(2)))
      .to.emit(market, "PriceUpdated")
      .withArgs(p, 1, ETH(1), ETH(2));
    await prints.transferFrom(ram.address, sita.address, 1);
    await expect(market.updatePrice(p, 1, ETH(3))).to.be.revertedWithCustomError(market, "NotOwner");
  });

  it("the seller can cancel; a stranger cannot cancel a valid listing", async function () {
    const { sita, market, p } = await loadFixture(listed);
    await expect(market.connect(sita).cancel(p, 1)).to.be.revertedWithCustomError(market, "StillValid");
    await expect(market.cancel(p, 1)).to.emit(market, "Cancelled");
    await expect(market.cancel(p, 1)).to.be.revertedWithCustomError(market, "NotListed");
    await expect(market.connect(sita).buy(p, 1, ETH(1), { value: ETH(1) })).to.be.revertedWithCustomError(market, "NotListed");
  });

  it("anyone can clean up a listing that can no longer be bought", async function () {
    const { ram, sita, eve, market, prints, m, p } = await loadFixture(listed);
    await prints.transferFrom(ram.address, sita.address, 1);
    expect(await market.isBuyable(p, 1)).to.equal(false);
    await expect(market.connect(eve).cancel(p, 1)).to.emit(market, "Cancelled").withArgs(p, 1, eve.address);
    // expired listing
    await prints.approve(m, 2);
    await market.list(p, 2, ETH(1), DAY);
    await time.increase(DAY + 1);
    await expect(market.connect(eve).cancel(p, 2)).to.emit(market, "Cancelled");
    // approval taken away
    await prints.approve(m, 3);
    await market.list(p, 3, ETH(1), DAY);
    await prints.approve(ethers.ZeroAddress, 3);
    await expect(market.connect(eve).cancel(p, 3)).to.emit(market, "Cancelled");
  });

  it("a new owner's listing replaces one left behind by the previous owner", async function () {
    const { ram, sita, hari, market, prints, m, p } = await loadFixture(listed);
    await prints.transferFrom(ram.address, sita.address, 1);
    await prints.connect(sita).approve(m, 1);
    await market.connect(sita).list(p, 1, ETH(3), DAY);
    expect((await market.listings(p, 1)).seller).to.equal(sita.address);
    await market.connect(hari).buy(p, 1, ETH(3), { value: ETH(3) });
    expect(await prints.ownerOf(1)).to.equal(hari.address);
    expect(await market.proceeds(sita.address)).to.equal(ETH(2.85));
    expect(await market.proceeds(ram.address)).to.equal(0);
  });
});

describe("HimalMarket — buying and royalties", function () {
  it("buys at the exact price: NFT to buyer, 95% to seller, 5% to the artist", async function () {
    const { ram, sita, artist, market, prints, p } = await loadFixture(listed);
    await expect(market.connect(sita).buy(p, 1, ETH(1), { value: ETH(1) }))
      .to.emit(market, "Sold")
      .withArgs(p, 1, sita.address, ram.address, ETH(1), artist.address, ETH(0.05));
    expect(await prints.ownerOf(1)).to.equal(sita.address);
    expect(await market.proceeds(ram.address)).to.equal(ETH(0.95));
    expect(await market.proceeds(artist.address)).to.equal(ETH(0.05));
    expect((await market.listings(p, 1)).seller).to.equal(ethers.ZeroAddress);
  });

  it("the artist keeps earning on every resale", async function () {
    const { sita, hari, artist, market, prints, m, p } = await loadFixture(listed);
    await market.connect(sita).buy(p, 1, ETH(1), { value: ETH(1) });
    await prints.connect(sita).approve(m, 1);
    await market.connect(sita).list(p, 1, ETH(4), DAY);
    await market.connect(hari).buy(p, 1, ETH(4), { value: ETH(4) });
    expect(await market.proceeds(artist.address)).to.equal(ETH(0.25)); // 0.05 + 0.20
    expect(await market.proceeds(sita.address)).to.equal(ETH(3.8));
  });

  it("withdraw pays out and zeroes the balance", async function () {
    const { ram, sita, artist, market, p } = await loadFixture(listed);
    await market.connect(sita).buy(p, 1, ETH(1), { value: ETH(1) });
    await expect(market.withdraw()).to.changeEtherBalances([ram, market], [ETH(0.95), -ETH(0.95)]);
    await expect(market.connect(artist).withdraw()).to.changeEtherBalance(artist, ETH(0.05));
    await expect(market.withdraw()).to.be.revertedWithCustomError(market, "NothingToWithdraw");
    expect(await ethers.provider.getBalance(market.target)).to.equal(0);
  });

  it("wrong payment, wrong expected price and self-buying are rejected", async function () {
    const { ram, sita, market, p } = await loadFixture(listed);
    await expect(market.connect(sita).buy(p, 1, ETH(1), { value: ETH(0.99) })).to.be.revertedWithCustomError(market, "WrongPayment");
    await expect(market.connect(sita).buy(p, 1, ETH(1), { value: ETH(1.01) })).to.be.revertedWithCustomError(market, "WrongPayment");
    await expect(market.connect(sita).buy(p, 1, ETH(0.5), { value: ETH(0.5) }))
      .to.be.revertedWithCustomError(market, "PriceChanged")
      .withArgs(ETH(1));
    await expect(market.connect(ram).buy(p, 1, ETH(1), { value: ETH(1) })).to.be.revertedWithCustomError(market, "SellerCannotBuy");
  });

  it("front-running: a price raise while the buyer waits makes the buy fail, not cost more", async function () {
    const { sita, market, prints, p } = await loadFixture(listed);
    // The seller sees Sita's waiting purchase and raises the price first.
    await market.updatePrice(p, 1, ETH(5));
    // Even if Sita had sent 5 ETH by mistake, her expected price protects her.
    await expect(market.connect(sita).buy(p, 1, ETH(1), { value: ETH(5) })).to.be.revertedWithCustomError(market, "PriceChanged");
    expect(await prints.ownerOf(1)).to.not.equal(sita.address);
  });

  it("an expired listing cannot be bought (edge: works at the last second)", async function () {
    const { sita, hari, market, prints, m, p } = await loadFixture(deploy);
    await prints.approve(m, 1);
    await prints.approve(m, 2);
    await market.list(p, 1, ETH(1), DAY);
    const exp = (await market.listings(p, 1)).expiresAt;
    await time.setNextBlockTimestamp(exp);
    await expect(market.connect(sita).buy(p, 1, ETH(1), { value: ETH(1) })).to.not.be.reverted;
    await market.list(p, 2, ETH(1), DAY);
    const exp2 = (await market.listings(p, 2)).expiresAt;
    await time.setNextBlockTimestamp(exp2 + 1n);
    await expect(market.connect(hari).buy(p, 2, ETH(1), { value: ETH(1) })).to.be.revertedWithCustomError(market, "ListingExpired");
  });

  it("a collection without ERC-2981 pays the seller 100%", async function () {
    const { ram, sita, market, m } = await loadFixture(deploy);
    const plain = await ethers.deployContract("PlainNFT");
    await plain.approve(m, 1);
    await market.list(plain.target, 1, ETH(1), DAY);
    await market.connect(sita).buy(plain.target, 1, ETH(1), { value: ETH(1) });
    expect(await market.proceeds(ram.address)).to.equal(ETH(1));
  });

  it("a greedy royalty (100%) is capped at 10%", async function () {
    const { ram, sita, eve, market, m } = await loadFixture(deploy);
    const greedy = await ethers.deployContract("GreedyNFT", [eve.address, 10_000]);
    await greedy.approve(m, 1);
    await market.list(greedy.target, 1, ETH(2), DAY);
    const q = await market.quote(greedy.target, 1, ETH(2));
    expect(q.royalty).to.equal(ETH(0.2));
    await market.connect(sita).buy(greedy.target, 1, ETH(2), { value: ETH(2) });
    expect(await market.proceeds(eve.address)).to.equal(ETH(0.2));
    expect(await market.proceeds(ram.address)).to.equal(ETH(1.8));
  });

  it("a royalty bigger than the price (overflow attempt) is also capped", async function () {
    const { ram, sita, eve, market, m } = await loadFixture(deploy);
    const greedy = await ethers.deployContract("GreedyNFT", [eve.address, 50_000]); // 500%
    await greedy.approve(m, 1);
    await market.list(greedy.target, 1, ETH(1), DAY);
    await market.connect(sita).buy(greedy.target, 1, ETH(1), { value: ETH(1) });
    expect(await market.proceeds(ram.address)).to.equal(ETH(0.9));
  });

  it("a broken royaltyInfo or a zero receiver does not block the sale", async function () {
    const { ram, sita, hari, eve, market, m } = await loadFixture(deploy);
    const greedy = await ethers.deployContract("GreedyNFT", [eve.address, 500]);
    await greedy.setRoyalty(eve.address, 500, true); // royaltyInfo reverts
    await greedy.setApprovalForAll(m, true);
    await market.list(greedy.target, 1, ETH(1), DAY);
    await market.connect(sita).buy(greedy.target, 1, ETH(1), { value: ETH(1) });
    expect(await market.proceeds(ram.address)).to.equal(ETH(1));
    await greedy.setRoyalty(ethers.ZeroAddress, 500, false); // nobody to pay
    await market.list(greedy.target, 2, ETH(1), DAY);
    await market.connect(hari).buy(greedy.target, 2, ETH(1), { value: ETH(1) });
    expect(await market.proceeds(ram.address)).to.equal(ETH(2));
  });

  it("rounding: tiny prices never create or lose wei", async function () {
    const { ram, sita, artist, market, p } = await loadFixture(listed);
    await market.updatePrice(p, 1, 19n); // 5% of 19 wei = 0.95 -> 0
    await market.connect(sita).buy(p, 1, 19n, { value: 19n });
    expect((await market.proceeds(ram.address)) + (await market.proceeds(artist.address))).to.equal(19n);
  });
});

describe("HimalMarket — selling NFTs you no longer own (security focus)", function () {
  it("ATTACK on the naive market: an old listing sells the new owner's NFT", async function () {
    const { ram, sita, hari } = await loadFixture(deploy);
    const naive = await ethers.deployContract("NaiveMarket");
    const prints = await ethers.deployContract("HimalPrints", [1, ram.address, 0]);
    await prints.setApprovalForAll(naive.target, true);
    await naive.list(prints.target, 1, ETH(1));
    // Ram sells the NFT to Sita privately. Sita also uses the naive market, so she approved it.
    await prints.transferFrom(ram.address, sita.address, 1);
    await prints.connect(sita).setApprovalForAll(naive.target, true);
    // Hari buys through Ram's OLD listing: Sita loses her NFT and Ram gets paid again.
    await expect(naive.connect(hari).buy(prints.target, 1, { value: ETH(1) })).to.changeEtherBalance(ram, ETH(1));
    expect(await prints.ownerOf(1)).to.equal(hari.address);
  });

  it("the same attack fails on HimalMarket with StaleListing", async function () {
    const { ram, sita, hari, market, prints, m, p } = await loadFixture(deploy);
    await prints.setApprovalForAll(m, true);
    await market.list(p, 1, ETH(1), DAY);
    await prints.transferFrom(ram.address, sita.address, 1);
    await prints.connect(sita).setApprovalForAll(m, true);
    await expect(market.connect(hari).buy(p, 1, ETH(1), { value: ETH(1) })).to.be.revertedWithCustomError(market, "StaleListing");
    expect(await prints.ownerOf(1)).to.equal(sita.address);
  });

  it("a listing whose approval was taken away fails with NotApproved", async function () {
    const { sita, market, prints, p } = await loadFixture(listed);
    await prints.approve(ethers.ZeroAddress, 1);
    expect(await market.isBuyable(p, 1)).to.equal(false);
    await expect(market.connect(sita).buy(p, 1, ETH(1), { value: ETH(1) })).to.be.revertedWithCustomError(market, "NotApproved");
  });

  it("a burned NFT's listing is not buyable and can be cleaned up", async function () {
    const { sita, eve, market, m } = await loadFixture(deploy);
    const greedy = await ethers.deployContract("GreedyNFT", [eve.address, 0]);
    await greedy.approve(m, 1);
    await market.list(greedy.target, 1, ETH(1), DAY);
    await greedy.burn(1);
    expect(await market.isBuyable(greedy.target, 1)).to.equal(false);
    await expect(market.connect(sita).buy(greedy.target, 1, ETH(1), { value: ETH(1) })).to.be.reverted;
    await expect(market.connect(eve).cancel(greedy.target, 1)).to.emit(market, "Cancelled");
  });

  it("the same NFT cannot be sold twice", async function () {
    const { sita, hari, market, p } = await loadFixture(listed);
    await market.connect(sita).buy(p, 1, ETH(1), { value: ETH(1) });
    await expect(market.connect(hari).buy(p, 1, ETH(1), { value: ETH(1) })).to.be.revertedWithCustomError(market, "NotListed");
  });
});

describe("HimalMarket — hostile wallets", function () {
  it("an artist wallet that rejects ETH cannot block sales or the seller's payout", async function () {
    const { ram, sita, market, m } = await loadFixture(deploy);
    const bad = await ethers.deployContract("RejectingWallet");
    const prints = await ethers.deployContract("HimalPrints", [2, bad.target, 500]);
    await prints.setApprovalForAll(m, true);
    await market.list(prints.target, 1, ETH(1), DAY);
    await market.connect(sita).buy(prints.target, 1, ETH(1), { value: ETH(1) });
    await expect(market.withdraw()).to.changeEtherBalance(ram, ETH(0.95));
    await expect(bad.withdrawFrom(market.target)).to.be.revertedWithCustomError(market, "TransferFailed");
    expect(await market.proceeds(bad.target)).to.equal(ETH(0.05)); // still owed, only hurts itself
  });

  it("reentrancy: withdrawing again from inside the payout fails", async function () {
    const { sita, market, prints, p } = await loadFixture(deploy);
    const re = await ethers.deployContract("ReentrantWallet", [market.target]);
    await prints.transferFrom((await ethers.getSigners())[0].address, re.target, 1);
    await re.approveAndList(p, 1, ETH(1));
    await market.connect(sita).buy(p, 1, ETH(1), { value: ETH(1) });
    await re.setTarget(p, 1, 0, 1);
    await re.doWithdraw();
    expect(await re.reentryBlocked()).to.equal(true);
    expect(await ethers.provider.getBalance(re.target)).to.equal(ETH(0.95));
    expect(await market.proceeds(re.target)).to.equal(0);
  });

  it("reentrancy: buying from inside a payout is blocked by the guard", async function () {
    const { ram, sita, market, prints, m, p } = await loadFixture(deploy);
    const re = await ethers.deployContract("ReentrantWallet", [market.target]);
    await prints.transferFrom(ram.address, re.target, 1);
    await re.approveAndList(p, 1, ETH(1));
    await market.connect(sita).buy(p, 1, ETH(1), { value: ETH(1) });
    await prints.approve(m, 2);
    await market.list(p, 2, ETH(0.5), DAY);
    await re.setTarget(p, 2, ETH(0.5), 2);
    await re.doWithdraw();
    expect(await re.reentryBlocked()).to.equal(true);
    expect(await prints.ownerOf(2)).to.equal(ram.address);
  });

  it("a buyer contract without onERC721Received still receives the NFT", async function () {
    const { market, prints, p } = await loadFixture(listed);
    const buyer = await ethers.deployContract("PlainBuyer");
    await buyer.buy(market.target, p, 1, ETH(1), { value: ETH(1) });
    expect(await prints.ownerOf(1)).to.equal(buyer.target);
  });
});

describe("HimalMarket — fuzz (fast-check)", function () {
  it("100 random price/royalty pairs: seller + royalty always equals the price, royalty never above 10%", async function () {
    const { ram, sita, eve, market, m } = await loadFixture(deploy);
    const greedy = await ethers.deployContract("GreedyNFT", [eve.address, 0]);
    await greedy.setApprovalForAll(m, true);
    await fc.assert(
      fc.asyncProperty(fc.bigInt({ min: 1n, max: 10n ** 24n }), fc.integer({ min: 0, max: 100_000 }), async (price, bps) => {
        await greedy.setRoyalty(eve.address, bps, false);
        const q = await market.quote(greedy.target, 1, price);
        expect(q.royalty + q.sellerGets).to.equal(price);
        expect(q.royalty <= (price * 1000n) / 10000n).to.equal(true);
      }),
      { numRuns: 100 }
    );
    void ram; void sita;
  });

  it("40 random buy/resell/withdraw sequences: the market always holds exactly what it owes", async function () {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ who: fc.integer({ min: 0, max: 3 }), price: fc.integer({ min: 1, max: 50 }), action: fc.integer({ min: 0, max: 2 }) }), { minLength: 1, maxLength: 12 }),
        async (steps) => {
          const { ram, sita, hari, eve, artist, market, prints, m, p } = await deploy();
          const people = [ram, sita, hari, eve];
          const all = [...people, artist];
          for (const s of steps) {
            const owner = await prints.ownerOf(1);
            const seller = people.find((x) => x.address === owner);
            const buyer = people[s.who];
            const price = ETH(s.price / 10);
            if (s.action === 0 && seller) {
              await prints.connect(seller).approve(m, 1);
              await market.connect(seller).list(p, 1, price, DAY);
            } else if (s.action === 1) {
              const l = await market.listings(p, 1);
              if (l.seller !== ethers.ZeroAddress && l.seller !== buyer.address) {
                await market.connect(buyer).buy(p, 1, l.price, { value: l.price });
              }
            } else if ((await market.proceeds(buyer.address)) > 0n) {
              await market.connect(buyer).withdraw();
            }
            let owed = 0n;
            for (const a of all) owed += await market.proceeds(a.address);
            expect(await ethers.provider.getBalance(m)).to.equal(owed);
          }
        }
      ),
      { numRuns: 40 }
    );
  });
});
