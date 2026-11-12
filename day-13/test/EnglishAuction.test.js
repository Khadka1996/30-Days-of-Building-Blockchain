const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const fc = require("fast-check");

const ETH = (n) => ethers.parseEther(String(n));
const HOUR = 60 * 60;
const DAY = 24 * HOUR;
const MIN10 = 10 * 60;
const RESERVE = ETH(1);

async function deploy() {
  const [seller, ram, sita, hari, eve] = await ethers.getSigners();
  const art = await ethers.deployContract("HimalArt", [3]);
  const auction = await ethers.deployContract("EnglishAuction", [await art.getAddress(), 1, RESERVE, DAY]);
  const addr = await auction.getAddress();
  return { seller, ram, sita, hari, eve, art, auction, addr };
}

async function started() {
  const f = await deploy();
  await f.art.approve(f.addr, 1);
  await f.auction.start();
  return { ...f, endAt: await f.auction.endAt() };
}

describe("EnglishAuction: setup", function () {
  it("stores the settings and starts empty", async function () {
    const { auction, art, seller } = await loadFixture(deploy);
    expect(await auction.nft()).to.equal(await art.getAddress());
    expect(await auction.tokenId()).to.equal(1);
    expect(await auction.seller()).to.equal(seller.address);
    expect(await auction.reservePrice()).to.equal(RESERVE);
    expect(await auction.duration()).to.equal(DAY);
    expect(await auction.endAt()).to.equal(0);
    expect(await auction.minNextBid()).to.equal(RESERVE);
  });

  it("rejects bad constructor values", async function () {
    const { art } = await loadFixture(deploy);
    const F = await ethers.getContractFactory("EnglishAuction");
    const a = await art.getAddress();
    await expect(F.deploy(ethers.ZeroAddress, 1, RESERVE, DAY)).to.be.revertedWithCustomError(F, "ZeroAddress");
    await expect(F.deploy(a, 1, 0, DAY)).to.be.revertedWithCustomError(F, "ZeroReserve");
    await expect(F.deploy(a, 1, RESERVE, HOUR - 1)).to.be.revertedWithCustomError(F, "BadDuration");
    await expect(F.deploy(a, 1, RESERVE, 30 * DAY + 1)).to.be.revertedWithCustomError(F, "BadDuration");
    await F.deploy(a, 1, RESERVE, HOUR);
    await F.deploy(a, 1, RESERVE, 30 * DAY);
  });

  it("only the seller can start, only once, and the NFT moves in", async function () {
    const { auction, art, addr, ram } = await loadFixture(deploy);
    await art.approve(addr, 1);
    await expect(auction.connect(ram).start()).to.be.revertedWithCustomError(auction, "NotSeller");
    const tx = await auction.start();
    const endAt = (await time.latest()) + DAY;
    await expect(tx).to.emit(auction, "Started").withArgs(endAt);
    expect(await art.ownerOf(1)).to.equal(addr);
    expect(await auction.endAt()).to.equal(endAt);
    await expect(auction.start()).to.be.revertedWithCustomError(auction, "AlreadyStarted");
  });
});

describe("EnglishAuction: bidding", function () {
  it("no bids before start", async function () {
    const { auction, ram } = await loadFixture(deploy);
    await expect(auction.connect(ram).bid({ value: RESERVE })).to.be.revertedWithCustomError(auction, "NotStarted");
  });

  it("the first bid must meet the reserve", async function () {
    const { auction, ram } = await loadFixture(started);
    await expect(auction.connect(ram).bid({ value: RESERVE - 1n }))
      .to.be.revertedWithCustomError(auction, "BidTooLow").withArgs(RESERVE);
    await expect(auction.connect(ram).bid({ value: RESERVE }))
      .to.emit(auction, "BidPlaced");
    expect(await auction.highestBidder()).to.equal(ram.address);
    expect(await auction.highestBid()).to.equal(RESERVE);
  });

  it("each new bid must be at least 5% higher, rounded up", async function () {
    const { auction, ram, sita } = await loadFixture(started);
    await auction.connect(ram).bid({ value: RESERVE });
    expect(await auction.minNextBid()).to.equal(ETH("1.05"));
    await expect(auction.connect(sita).bid({ value: ETH("1.05") - 1n }))
      .to.be.revertedWithCustomError(auction, "BidTooLow").withArgs(ETH("1.05"));
    await auction.connect(sita).bid({ value: ETH("1.05") });
    expect(await auction.highestBidder()).to.equal(sita.address);
  });

  it("the step is never zero, even for a tiny reserve", async function () {
    const { art } = await loadFixture(deploy);
    const tiny = await ethers.deployContract("EnglishAuction", [await art.getAddress(), 2, 1, DAY]);
    await art.approve(await tiny.getAddress(), 2);
    await tiny.start();
    const [, ram, sita] = await ethers.getSigners();
    await tiny.connect(ram).bid({ value: 1 });
    expect(await tiny.minNextBid()).to.equal(2);
    await expect(tiny.connect(sita).bid({ value: 1 })).to.be.revertedWithCustomError(tiny, "BidTooLow");
  });

  it("the seller cannot bid up their own item", async function () {
    const { auction, seller } = await loadFixture(started);
    await expect(auction.connect(seller).bid({ value: RESERVE })).to.be.revertedWithCustomError(auction, "SellerCannotBid");
  });

  it("an outbid bidder is credited, not paid, and can withdraw", async function () {
    const { auction, ram, sita } = await loadFixture(started);
    await auction.connect(ram).bid({ value: ETH(1) });
    await auction.connect(sita).bid({ value: ETH(2) });
    expect(await auction.pendingReturns(ram.address)).to.equal(ETH(1));
    await expect(auction.connect(ram).withdraw()).to.changeEtherBalances([ram, auction], [ETH(1), -ETH(1)]);
    expect(await auction.pendingReturns(ram.address)).to.equal(0);
    await expect(auction.connect(ram).withdraw()).to.be.revertedWithCustomError(auction, "NothingToWithdraw");
  });

  it("the leader can raise their own bid; the old bid becomes withdrawable", async function () {
    const { auction, ram } = await loadFixture(started);
    await auction.connect(ram).bid({ value: ETH(1) });
    await auction.connect(ram).bid({ value: ETH(2) });
    expect(await auction.highestBid()).to.equal(ETH(2));
    expect(await auction.pendingReturns(ram.address)).to.equal(ETH(1));
  });

  it("a bid on the last second works; at the end time it fails", async function () {
    const { auction, ram, sita, endAt } = await loadFixture(started);
    await auction.connect(ram).bid({ value: ETH(1) });
    await time.setNextBlockTimestamp(endAt - 1n);
    await auction.connect(sita).bid({ value: ETH(2) }); // extends the end
    const newEnd = await auction.endAt();
    await time.setNextBlockTimestamp(newEnd);
    await expect(auction.connect(ram).bid({ value: ETH(3) })).to.be.revertedWithCustomError(auction, "AuctionClosed");
  });
});

describe("EnglishAuction: anti-sniping", function () {
  it("a bid in the last 10 minutes moves the end to 10 minutes after that bid", async function () {
    const { auction, ram, sita, endAt } = await loadFixture(started);
    await auction.connect(ram).bid({ value: ETH(1) });
    const at = endAt - 60n; // one minute before the end
    await time.setNextBlockTimestamp(at);
    await expect(auction.connect(sita).bid({ value: ETH(2) }))
      .to.emit(auction, "Extended").withArgs(at + BigInt(MIN10));
    expect(await auction.endAt()).to.equal(at + BigInt(MIN10));
  });

  it("a bid exactly 10 minutes before the end does not extend", async function () {
    const { auction, ram, endAt } = await loadFixture(started);
    await time.setNextBlockTimestamp(endAt - BigInt(MIN10));
    await expect(auction.connect(ram).bid({ value: ETH(1) })).not.to.emit(auction, "Extended");
    expect(await auction.endAt()).to.equal(endAt);
  });

  it("a sniper's last-second bid gives the others time to answer", async function () {
    const { auction, ram, eve, endAt } = await loadFixture(started);
    await auction.connect(ram).bid({ value: ETH(1) });
    await time.setNextBlockTimestamp(endAt - 1n);
    await auction.connect(eve).bid({ value: ETH("1.05") });
    await time.increase(5 * 60);
    await auction.connect(ram).bid({ value: ETH(2) }); // Ram still has time to answer
    await time.increaseTo(await auction.endAt());
    await auction.end();
    expect(await auction.highestBidder()).to.equal(ram.address);
  });
});

describe("EnglishAuction: ending", function () {
  it("cannot end before the end time; anyone can end after it", async function () {
    const { auction, art, ram, sita, hari, seller, endAt } = await loadFixture(started);
    await auction.connect(ram).bid({ value: ETH(1) });
    await auction.connect(sita).bid({ value: ETH(2) });
    await time.setNextBlockTimestamp(endAt - 1n);
    await expect(auction.connect(hari).end()).to.be.revertedWithCustomError(auction, "AuctionStillRunning");
    await time.setNextBlockTimestamp(endAt);
    await expect(auction.connect(hari).end()).to.emit(auction, "Ended").withArgs(sita.address, ETH(2));
    expect(await art.ownerOf(1)).to.equal(sita.address);
    expect(await auction.pendingReturns(seller.address)).to.equal(ETH(2));
    await expect(auction.end()).to.be.revertedWithCustomError(auction, "AuctionClosed");
    await expect(auction.connect(hari).bid({ value: ETH(5) })).to.be.revertedWithCustomError(auction, "AuctionClosed");
  });

  it("the seller and the losers each collect exactly their money; the contract ends at zero", async function () {
    const { auction, ram, sita, seller, endAt } = await loadFixture(started);
    await auction.connect(ram).bid({ value: ETH(1) });
    await auction.connect(sita).bid({ value: ETH(2) });
    await time.increaseTo(endAt);
    await auction.end();
    await expect(auction.connect(seller).withdraw()).to.changeEtherBalance(seller, ETH(2));
    await expect(auction.connect(ram).withdraw()).to.changeEtherBalance(ram, ETH(1));
    await expect(auction.connect(sita).withdraw()).to.be.revertedWithCustomError(auction, "NothingToWithdraw");
    expect(await ethers.provider.getBalance(await auction.getAddress())).to.equal(0);
  });

  it("with no bids, the NFT goes back to the seller", async function () {
    const { auction, art, seller, endAt } = await loadFixture(started);
    await time.increaseTo(endAt);
    await expect(auction.end()).to.emit(auction, "Ended").withArgs(ethers.ZeroAddress, 0);
    expect(await art.ownerOf(1)).to.equal(seller.address);
  });

  it("cannot end before it started", async function () {
    const { auction } = await loadFixture(deploy);
    await expect(auction.end()).to.be.revertedWithCustomError(auction, "NotStarted");
  });
});

describe("EnglishAuction: cancelling", function () {
  it("the seller can cancel only while there are no bids", async function () {
    const { auction, art, seller, ram } = await loadFixture(started);
    await expect(auction.connect(ram).cancel()).to.be.revertedWithCustomError(auction, "NotSeller");
    await expect(auction.cancel()).to.emit(auction, "Cancelled");
    expect(await art.ownerOf(1)).to.equal(seller.address);
    await expect(auction.cancel()).to.be.revertedWithCustomError(auction, "AuctionClosed");
    await expect(auction.connect(ram).bid({ value: RESERVE })).to.be.revertedWithCustomError(auction, "AuctionClosed");
  });

  it("the seller cannot pull the item once someone has bid", async function () {
    const { auction, ram } = await loadFixture(started);
    await auction.connect(ram).bid({ value: RESERVE });
    await expect(auction.cancel()).to.be.revertedWithCustomError(auction, "HasBids");
  });

  it("cannot cancel before start", async function () {
    const { auction } = await loadFixture(deploy);
    await expect(auction.cancel()).to.be.revertedWithCustomError(auction, "NotStarted");
  });
});

describe("EnglishAuction: attacks", function () {
  it("refund DoS: the naive push-refund auction is frozen by one bad bidder", async function () {
    const [, ram] = await ethers.getSigners();
    const naive = await ethers.deployContract("PushRefundAuction");
    const bad = await ethers.deployContract("RejectingBidder");
    await bad.bid(await naive.getAddress(), { value: ETH(1) });
    await expect(naive.connect(ram).bid({ value: ETH(5) })).to.be.revertedWith("refund failed");
  });

  it("refund DoS: a bidder that rejects ETH cannot block new bids or the end", async function () {
    const { auction, addr, art, ram, seller, endAt } = await loadFixture(started);
    const bad = await ethers.deployContract("RejectingBidder");
    await bad.bid(addr, { value: ETH(1) });
    await auction.connect(ram).bid({ value: ETH(2) }); // works: the bad bidder is only credited
    expect(await auction.pendingReturns(await bad.getAddress())).to.equal(ETH(1));
    await expect(bad.withdrawFrom(addr)).to.be.revertedWithCustomError(auction, "TransferFailed"); // only hurts itself
    expect(await auction.pendingReturns(await bad.getAddress())).to.equal(ETH(1)); // still owed
    await time.increaseTo(endAt);
    await auction.end();
    expect(await art.ownerOf(1)).to.equal(ram.address);
    await expect(auction.connect(seller).withdraw()).to.changeEtherBalance(seller, ETH(2));
  });

  it("a winner contract that rejects NFTs cannot lock the seller's money", async function () {
    const { auction, addr, art, seller, endAt } = await loadFixture(started);
    const bad = await ethers.deployContract("RejectingBidder");
    await bad.bid(addr, { value: ETH(3) });
    await time.increaseTo(endAt);
    await auction.end(); // would revert with safeTransferFrom
    expect(await art.ownerOf(1)).to.equal(await bad.getAddress());
    await expect(auction.connect(seller).withdraw()).to.changeEtherBalance(seller, ETH(3));
  });

  it("reentrancy: calling withdraw again while being paid gets nothing extra", async function () {
    const { auction, addr, ram } = await loadFixture(started);
    const thief = await ethers.deployContract("ReentrantBidder");
    await thief.bid(addr, { value: ETH(1) });
    await auction.connect(ram).bid({ value: ETH(2) });
    await expect(thief.withdrawFrom(addr)).to.changeEtherBalance(thief, ETH(1));
    expect(await thief.reentryAttempts()).to.equal(1);
    expect(await thief.reentrySucceeded()).to.equal(false);
    expect(await ethers.provider.getBalance(addr)).to.equal(ETH(2));
  });

  it("front-running: a bid that gets beaten while waiting just reverts, no money lost", async function () {
    const { auction, ram, eve } = await loadFixture(started);
    await auction.connect(ram).bid({ value: ETH(1) });
    // Eve sees Sita's 1.05 ETH bid waiting and jumps ahead with 2 ETH.
    await auction.connect(eve).bid({ value: ETH(2) });
    const [, , sita] = await ethers.getSigners();
    const before = await ethers.provider.getBalance(sita.address);
    await expect(auction.connect(sita).bid({ value: ETH("1.05") })).to.be.revertedWithCustomError(auction, "BidTooLow");
    const after = await ethers.provider.getBalance(sita.address);
    expect(before - after < ETH("0.001")).to.equal(true); // only gas
  });
});

describe("EnglishAuction: fuzz (fast-check)", function () {
  it("money in always equals the top bid plus everything owed back", async function () {
    this.timeout(120000);
    const signers = await ethers.getSigners();
    const bidders = signers.slice(1, 6);

    const step = fc.record({
      who: fc.integer({ min: 0, max: bidders.length - 1 }),
      kind: fc.constantFrom("bid", "bid", "low", "withdraw", "wait"),
      extra: fc.integer({ min: 0, max: 3000 }), // basis points above the minimum
      wait: fc.integer({ min: 1, max: 6 * HOUR }),
    });

    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 25 }), async (steps) => {
        const { auction, addr, seller, art } = await loadFixture(started);
        const owed = new Map();
        let top = 0n;
        let leader = null;
        for (const s of steps) {
          const b = bidders[s.who];
          const open = (await time.latest()) + 1 < Number(await auction.endAt());
          if (s.kind === "wait") {
            await time.increase(s.wait);
          } else if (s.kind === "withdraw") {
            const due = owed.get(b.address) || 0n;
            if (due > 0n) { await auction.connect(b).withdraw(); owed.set(b.address, 0n); }
            else await expect(auction.connect(b).withdraw()).to.be.reverted;
          } else {
            const min = await auction.minNextBid();
            const amount = s.kind === "low" ? min - 1n : min + (min * BigInt(s.extra)) / 10000n;
            if (s.kind === "low" || !open) {
              await expect(auction.connect(b).bid({ value: amount })).to.be.reverted;
            } else {
              await auction.connect(b).bid({ value: amount });
              if (leader) owed.set(leader, (owed.get(leader) || 0n) + top);
              leader = b.address; top = amount;
            }
          }
          let sumOwed = 0n;
          for (const v of owed.values()) sumOwed += v;
          expect(await ethers.provider.getBalance(addr)).to.equal(top + sumOwed);
          expect(await auction.highestBid()).to.equal(top);
          for (const x of bidders) expect(await auction.pendingReturns(x.address)).to.equal(owed.get(x.address) || 0n);
        }
        // Settle and drain: everyone gets exactly what they are owed, the contract ends at 0.
        await time.increaseTo(await auction.endAt());
        await auction.end();
        expect(await art.ownerOf(1)).to.equal(leader || seller.address);
        if (top > 0n) await auction.connect(seller).withdraw();
        for (const x of bidders) if ((owed.get(x.address) || 0n) > 0n) await auction.connect(x).withdraw();
        expect(await ethers.provider.getBalance(addr)).to.equal(0);
      }),
      { numRuns: 60 }
    );
  });
});
