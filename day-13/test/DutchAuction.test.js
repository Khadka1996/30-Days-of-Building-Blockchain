const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const fc = require("fast-check");

const ETH = (n) => ethers.parseEther(String(n));
const HOUR = 60 * 60;
const DAY = 24 * HOUR;
const START = ETH(10);
const FLOOR = ETH(1);

async function deploy() {
  const [seller, ram, sita, eve] = await ethers.getSigners();
  const art = await ethers.deployContract("HimalArt", [3]);
  const auction = await ethers.deployContract("DutchAuction", [await art.getAddress(), 1, START, FLOOR, DAY]);
  return { seller, ram, sita, eve, art, auction, addr: await auction.getAddress() };
}

async function started() {
  const f = await deploy();
  await f.art.approve(f.addr, 1);
  await f.auction.start();
  return { ...f, startAt: await f.auction.startAt() };
}

// The same formula as the contract, in JavaScript.
function expected(elapsed, start = START, floor = FLOOR, duration = BigInt(DAY)) {
  if (elapsed >= duration) return floor;
  return start - ((start - floor) * elapsed) / duration;
}

describe("DutchAuction: setup", function () {
  it("rejects bad constructor values", async function () {
    const { art } = await loadFixture(deploy);
    const F = await ethers.getContractFactory("DutchAuction");
    const a = await art.getAddress();
    await expect(F.deploy(ethers.ZeroAddress, 1, START, FLOOR, DAY)).to.be.revertedWithCustomError(F, "ZeroAddress");
    await expect(F.deploy(a, 1, FLOOR, FLOOR, DAY)).to.be.revertedWithCustomError(F, "BadPrices");
    await expect(F.deploy(a, 1, FLOOR, START, DAY)).to.be.revertedWithCustomError(F, "BadPrices");
    await expect(F.deploy(a, 1, START, FLOOR, HOUR - 1)).to.be.revertedWithCustomError(F, "BadDuration");
    await expect(F.deploy(a, 1, START, FLOOR, 30 * DAY + 1)).to.be.revertedWithCustomError(F, "BadDuration");
    await F.deploy(a, 1, START, 0, HOUR); // a floor of zero is allowed
  });

  it("only the seller can start, only once; the NFT moves in", async function () {
    const { auction, art, addr, ram } = await loadFixture(deploy);
    expect(await auction.currentPrice()).to.equal(START);
    await art.approve(addr, 1);
    await expect(auction.connect(ram).start()).to.be.revertedWithCustomError(auction, "NotSeller");
    await expect(auction.start()).to.emit(auction, "Started");
    expect(await art.ownerOf(1)).to.equal(addr);
    await expect(auction.start()).to.be.revertedWithCustomError(auction, "AlreadyStarted");
  });

  it("no buying before start", async function () {
    const { auction, ram } = await loadFixture(deploy);
    await expect(auction.connect(ram).buy({ value: START })).to.be.revertedWithCustomError(auction, "NotStarted");
  });
});

describe("DutchAuction: price", function () {
  it("starts at the start price, halves the gap at half time, sits at the floor after", async function () {
    const { auction, startAt } = await loadFixture(started);
    expect(await auction.currentPrice()).to.equal(START);
    await time.increaseTo(startAt + BigInt(DAY / 2));
    expect(await auction.currentPrice()).to.equal(ETH("5.5"));
    await time.increaseTo(startAt + BigInt(DAY));
    expect(await auction.currentPrice()).to.equal(FLOOR);
    await time.increase(365 * DAY);
    expect(await auction.currentPrice()).to.equal(FLOOR);
  });

  it("fuzz: the price matches the formula, never goes up, never drops below the floor", async function () {
    await fc.assert(
      fc.asyncProperty(
        fc.bigInt({ min: 1n, max: ETH(1000) }),
        fc.bigInt({ min: 0n, max: ETH(1000) }),
        fc.integer({ min: HOUR, max: 30 * DAY }),
        fc.array(fc.integer({ min: 1, max: 2 * DAY }), { minLength: 1, maxLength: 6 }),
        async (a, b, duration, waits) => {
          if (a === b) return;
          const { art } = await loadFixture(deploy); // fresh chain state for every run
          const [start, floor] = a > b ? [a, b] : [b, a];
          const d = await ethers.deployContract("DutchAuction", [await art.getAddress(), 2, start, floor, duration]);
          await art.approve(await d.getAddress(), 2);
          await d.start();
          const t0 = await d.startAt();
          let last = start;
          for (const w of waits) {
            await time.increase(w);
            const now = BigInt(await time.latest());
            const p = await d.currentPrice();
            expect(p).to.equal(expected(now - t0, start, floor, BigInt(duration)));
            expect(p <= last).to.equal(true);
            expect(p >= floor).to.equal(true);
            last = p;
          }
        }
      ),
      { numRuns: 40 }
    );
  });
});

describe("DutchAuction: buying", function () {
  it("the first buyer pays the price at their block and gets the change back", async function () {
    const { auction, addr, art, ram, startAt } = await loadFixture(started);
    const at = startAt + BigInt(HOUR * 6);
    await time.setNextBlockTimestamp(at);
    const price = expected(at - startAt);
    const tx = auction.connect(ram).buy({ value: START });
    await expect(tx).to.changeEtherBalances([ram, auction], [-price, price]);
    await expect(tx).to.emit(auction, "Sold").withArgs(ram.address, price);
    expect(await art.ownerOf(1)).to.equal(ram.address);
    expect(await auction.buyer()).to.equal(ram.address);
    expect(await auction.soldPrice()).to.equal(price);
    expect(await ethers.provider.getBalance(addr)).to.equal(price);
  });

  it("sending less than the price fails with the price in the error", async function () {
    const { auction, ram, startAt } = await loadFixture(started);
    const at = startAt + 100n;
    await time.setNextBlockTimestamp(at);
    const price = expected(100n);
    await expect(auction.connect(ram).buy({ value: price - 1n }))
      .to.be.revertedWithCustomError(auction, "PriceAboveMax").withArgs(price, price - 1n);
  });

  it("exactly the price works (no change)", async function () {
    const { auction, ram, startAt } = await loadFixture(started);
    const at = startAt + 200n;
    await time.setNextBlockTimestamp(at);
    await expect(auction.connect(ram).buy({ value: expected(200n) })).to.emit(auction, "Sold");
  });

  it("only one buyer: the second one is rejected", async function () {
    const { auction, ram, sita } = await loadFixture(started);
    await auction.connect(ram).buy({ value: START });
    await expect(auction.connect(sita).buy({ value: START })).to.be.revertedWithCustomError(auction, "AuctionClosed");
  });

  it("the seller cannot buy their own item", async function () {
    const { auction, seller } = await loadFixture(started);
    await expect(auction.connect(seller).buy({ value: START })).to.be.revertedWithCustomError(auction, "SellerCannotBuy");
  });

  it("a slow transaction can only lower the price, never raise it", async function () {
    const { auction, ram } = await loadFixture(started);
    const quoted = await auction.currentPrice();
    await time.increase(HOUR); // stuck in the queue for an hour
    const tx = await auction.connect(ram).buy({ value: quoted });
    const rc = await tx.wait();
    const sold = auction.interface.parseLog(rc.logs.find((l) => l.address === auction.target && auction.interface.parseLog(l)?.name === "Sold"));
    expect(sold.args.price < quoted).to.equal(true);
  });
});

describe("DutchAuction: seller", function () {
  it("the seller withdraws the proceeds once; nobody else can", async function () {
    const { auction, seller, ram } = await loadFixture(started);
    await expect(auction.withdraw()).to.be.revertedWithCustomError(auction, "NothingToWithdraw");
    await auction.connect(ram).buy({ value: START });
    const price = await auction.soldPrice();
    await expect(auction.connect(ram).withdraw()).to.be.revertedWithCustomError(auction, "NotSeller");
    const tx = auction.withdraw();
    await expect(tx).to.changeEtherBalance(seller, price);
    await expect(tx).to.emit(auction, "Withdrawn").withArgs(price);
    await expect(auction.withdraw()).to.be.revertedWithCustomError(auction, "NothingToWithdraw");
    expect(await ethers.provider.getBalance(auction.target)).to.equal(0);
  });

  it("the seller can take an unsold NFT back only after the price drop ends", async function () {
    const f = await loadFixture(started);
    const endOfDrop = f.startAt + BigInt(DAY);
    await expect(f.auction.connect(f.ram).cancel()).to.be.revertedWithCustomError(f.auction, "NotSeller");
    await time.setNextBlockTimestamp(endOfDrop - 1n);
    await expect(f.auction.cancel()).to.be.revertedWithCustomError(f.auction, "PriceStillFalling");
    await time.setNextBlockTimestamp(endOfDrop);
    await expect(f.auction.cancel()).to.emit(f.auction, "Cancelled");
    expect(await f.art.ownerOf(1)).to.equal(f.seller.address);
    await expect(f.auction.connect(f.ram).buy({ value: START })).to.be.revertedWithCustomError(f.auction, "AuctionClosed");
  });

  it("cannot cancel after a sale", async function () {
    const g = await loadFixture(started);
    await g.auction.connect(g.ram).buy({ value: START });
    await time.increase(2 * DAY);
    await expect(g.auction.cancel()).to.be.revertedWithCustomError(g.auction, "AuctionClosed");
  });

  it("front-running: the seller cannot cancel in front of a buyer while the price falls", async function () {
    const { auction, ram, startAt } = await loadFixture(started);
    await time.setNextBlockTimestamp(startAt + BigInt(DAY - 60)); // price almost at the floor
    await expect(auction.cancel()).to.be.revertedWithCustomError(auction, "PriceStillFalling");
    await auction.connect(ram).buy({ value: START }); // the buyer's purchase still goes through
    expect(await auction.buyer()).to.equal(ram.address);
  });

  it("cannot cancel before start", async function () {
    const { auction } = await loadFixture(deploy);
    await expect(auction.cancel()).to.be.revertedWithCustomError(auction, "NotStarted");
  });
});

describe("DutchAuction: attacks", function () {
  it("a buyer contract that rejects NFTs via the safe hook still completes the sale", async function () {
    const { auction, addr, art } = await loadFixture(started);
    const odd = await ethers.deployContract("RejectingBidder");
    const price = await auction.currentPrice();
    // Send exactly the price so no change is needed (it rejects ETH too).
    await time.setNextBlockTimestamp((await auction.startAt()) + 50n);
    await odd.buyFrom(addr, { value: expected(50n) });
    expect(await art.ownerOf(1)).to.equal(await odd.getAddress());
    expect(price >= (await auction.soldPrice())).to.equal(true);
  });

  it("a buyer that rejects its change only blocks its own purchase", async function () {
    const { auction, addr, ram } = await loadFixture(started);
    const odd = await ethers.deployContract("RejectingBidder");
    await expect(odd.buyFrom(addr, { value: START * 2n })).to.be.revertedWithCustomError(auction, "TransferFailed");
    await auction.connect(ram).buy({ value: START }); // others still can buy
  });

  it("reentrancy: buying again from inside the change payment fails", async function () {
    const { auction, addr, art } = await loadFixture(started);
    const thief = await ethers.deployContract("ReentrantBidder");
    await thief.buyFrom(addr, { value: START });
    expect(await thief.reentryAttempts()).to.equal(1);
    expect(await thief.reentrySucceeded()).to.equal(false);
    expect(await art.ownerOf(1)).to.equal(await thief.getAddress());
    expect(await ethers.provider.getBalance(addr)).to.equal(await auction.soldPrice());
  });
});
