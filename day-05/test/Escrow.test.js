const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const fc = require("fast-check");

const ONE = ethers.parseEther("1");
const DAY = 24 * 60 * 60;
const S = { None: 0n, Funded: 1n, Disputed: 2n, Released: 3n, Refunded: 4n };

describe("Escrow", function () {
  // Deal 0: buyer pays 2 ETH to seller, arbiter decides disputes, 14 days to confirm.
  async function deploy() {
    const [buyer, seller, arbiter, eve, other] = await ethers.getSigners();
    const escrow = await ethers.deployContract("Escrow");
    await escrow.connect(buyer).openDeal(seller.address, arbiter.address, 14 * DAY, { value: 2n * ONE });
    const d = await escrow.getDeal(0);
    return { escrow, buyer, seller, arbiter, eve, other, deadline: d.deadline };
  }

  const balanceOf = async (c) => ethers.provider.getBalance(await c.getAddress());

  describe("open a deal", function () {
    it("stores the parties, amount and deadline and emits DealOpened", async function () {
      const { escrow, buyer, seller, arbiter } = await loadFixture(deploy);
      const now = await time.latest();
      await expect(escrow.connect(buyer).openDeal(seller.address, arbiter.address, DAY, { value: ONE }))
        .to.emit(escrow, "DealOpened")
        .withArgs(1, buyer.address, seller.address, arbiter.address, ONE, now + 1 + DAY);
      const d = await escrow.getDeal(1);
      expect(d.buyer).to.equal(buyer.address);
      expect(d.seller).to.equal(seller.address);
      expect(d.arbiter).to.equal(arbiter.address);
      expect(d.amount).to.equal(ONE);
      expect(d.state).to.equal(S.Funded);
      expect(await escrow.dealCount()).to.equal(2n);
      expect(await balanceOf(escrow)).to.equal(3n * ONE);
    });

    it("rejects zero payment, zero addresses, a too short or too long duration and unknown ids", async function () {
      const { escrow, seller, arbiter } = await loadFixture(deploy);
      const Z = ethers.ZeroAddress;
      await expect(escrow.openDeal(seller.address, arbiter.address, DAY)).to.be.revertedWithCustomError(escrow, "ZeroAmount");
      await expect(escrow.openDeal(Z, arbiter.address, DAY, { value: ONE })).to.be.revertedWithCustomError(escrow, "ZeroAddress");
      await expect(escrow.openDeal(seller.address, Z, DAY, { value: ONE })).to.be.revertedWithCustomError(escrow, "ZeroAddress");
      await expect(escrow.openDeal(seller.address, arbiter.address, 60, { value: ONE })).to.be.revertedWithCustomError(escrow, "BadDuration");
      await expect(escrow.openDeal(seller.address, arbiter.address, 181 * DAY, { value: ONE })).to.be.revertedWithCustomError(escrow, "BadDuration");
      await expect(escrow.getDeal(9)).to.be.revertedWithCustomError(escrow, "UnknownDeal");
      await expect(escrow.confirmDelivery(9)).to.be.revertedWithCustomError(escrow, "UnknownDeal");
      await expect(escrow.resolve(9, true)).to.be.revertedWithCustomError(escrow, "UnknownDeal");
    });

    it("the arbiter must be neutral: buyer, seller and arbiter are three different addresses", async function () {
      const { escrow, buyer, seller, arbiter } = await loadFixture(deploy);
      const e = (s, a) => escrow.connect(buyer).openDeal(s, a, DAY, { value: ONE });
      await expect(e(buyer.address, arbiter.address)).to.be.revertedWithCustomError(escrow, "PartiesNotDistinct");
      await expect(e(seller.address, buyer.address)).to.be.revertedWithCustomError(escrow, "PartiesNotDistinct");
      await expect(e(seller.address, seller.address)).to.be.revertedWithCustomError(escrow, "PartiesNotDistinct");
    });

    it("plain ETH sent to the contract is refused", async function () {
      const { escrow, eve } = await loadFixture(deploy);
      await expect(eve.sendTransaction({ to: await escrow.getAddress(), value: ONE }))
        .to.be.revertedWithCustomError(escrow, "DirectPaymentRejected");
    });
  });

  describe("happy paths", function () {
    it("buyer confirms delivery: the seller is credited and withdraws the full amount", async function () {
      const { escrow, buyer, seller } = await loadFixture(deploy);
      await expect(escrow.connect(buyer).confirmDelivery(0))
        .to.emit(escrow, "Released").withArgs(0, seller.address, 2n * ONE, buyer.address);
      expect((await escrow.getDeal(0)).state).to.equal(S.Released);
      expect(await escrow.owed(seller.address)).to.equal(2n * ONE);
      await expect(escrow.connect(seller).withdraw()).to.changeEtherBalances([seller, escrow], [2n * ONE, -2n * ONE]);
      expect(await escrow.owed(seller.address)).to.equal(0n);
    });

    it("seller refunds the buyer (e.g. out of stock)", async function () {
      const { escrow, buyer, seller } = await loadFixture(deploy);
      await expect(escrow.connect(seller).refundBuyer(0))
        .to.emit(escrow, "Refunded").withArgs(0, buyer.address, 2n * ONE, seller.address);
      await expect(escrow.connect(buyer).withdraw()).to.changeEtherBalances([buyer, escrow], [2n * ONE, -2n * ONE]);
    });

    it("owed money from several deals adds up and is withdrawn in one call", async function () {
      const { escrow, buyer, seller, arbiter } = await loadFixture(deploy);
      await escrow.connect(buyer).openDeal(seller.address, arbiter.address, DAY, { value: 3n * ONE });
      await escrow.connect(buyer).confirmDelivery(0);
      await escrow.connect(buyer).confirmDelivery(1);
      expect(await escrow.owed(seller.address)).to.equal(5n * ONE);
      await expect(escrow.connect(seller).withdraw()).to.changeEtherBalance(seller, 5n * ONE);
    });
  });

  describe("security: wrong person releasing", function () {
    it("only the buyer can confirm delivery (not the seller, arbiter or a stranger)", async function () {
      const { escrow, seller, arbiter, eve } = await loadFixture(deploy);
      for (const who of [seller, arbiter, eve]) {
        await expect(escrow.connect(who).confirmDelivery(0)).to.be.revertedWithCustomError(escrow, "NotBuyer");
      }
    });

    it("only the seller can refund the buyer", async function () {
      const { escrow, buyer, arbiter, eve } = await loadFixture(deploy);
      for (const who of [buyer, arbiter, eve]) {
        await expect(escrow.connect(who).refundBuyer(0)).to.be.revertedWithCustomError(escrow, "NotSeller");
      }
    });

    it("the arbiter cannot move money unless there is a dispute", async function () {
      const { escrow, arbiter } = await loadFixture(deploy);
      await expect(escrow.connect(arbiter).resolve(0, true))
        .to.be.revertedWithCustomError(escrow, "WrongState").withArgs(S.Funded);
      await expect(escrow.connect(arbiter).resolve(0, false))
        .to.be.revertedWithCustomError(escrow, "WrongState").withArgs(S.Funded);
    });

    it("only the arbiter can resolve, and only buyer or seller can dispute", async function () {
      const { escrow, buyer, seller, eve, arbiter } = await loadFixture(deploy);
      await expect(escrow.connect(eve).dispute(0)).to.be.revertedWithCustomError(escrow, "NotParty");
      await expect(escrow.connect(arbiter).dispute(0)).to.be.revertedWithCustomError(escrow, "NotParty");
      await escrow.connect(buyer).dispute(0);
      for (const who of [buyer, seller, eve]) {
        await expect(escrow.connect(who).resolve(0, true)).to.be.revertedWithCustomError(escrow, "NotArbiter");
      }
    });

    it("the arbiter never receives the money: it goes only to the buyer or the seller", async function () {
      const { escrow, buyer, seller, arbiter } = await loadFixture(deploy);
      await escrow.connect(seller).dispute(0);
      await escrow.connect(arbiter).resolve(0, true);
      expect(await escrow.owed(arbiter.address)).to.equal(0n);
      expect(await escrow.owed(seller.address)).to.equal(2n * ONE);
      await expect(escrow.connect(arbiter).withdraw()).to.be.revertedWithCustomError(escrow, "NothingToWithdraw");
      await escrow.connect(buyer).openDeal(seller.address, arbiter.address, DAY, { value: ONE });
      await escrow.connect(buyer).dispute(1);
      await expect(escrow.connect(arbiter).resolve(1, false))
        .to.emit(escrow, "Refunded").withArgs(1, buyer.address, ONE, arbiter.address);
      expect(await escrow.owed(buyer.address)).to.equal(ONE);
    });

    it("a stranger cannot withdraw someone else's money", async function () {
      const { escrow, buyer, seller, eve } = await loadFixture(deploy);
      await escrow.connect(buyer).confirmDelivery(0);
      await expect(escrow.connect(eve).withdraw()).to.be.revertedWithCustomError(escrow, "NothingToWithdraw");
      expect(await escrow.owed(seller.address)).to.equal(2n * ONE);
    });
  });

  describe("security: paying out twice", function () {
    it("a closed deal can never move again (state machine only moves forward)", async function () {
      const { escrow, buyer, seller, arbiter } = await loadFixture(deploy);
      await escrow.connect(buyer).confirmDelivery(0);
      const st = S.Released;
      await expect(escrow.connect(buyer).confirmDelivery(0)).to.be.revertedWithCustomError(escrow, "WrongState").withArgs(st);
      await expect(escrow.connect(seller).refundBuyer(0)).to.be.revertedWithCustomError(escrow, "WrongState").withArgs(st);
      await expect(escrow.connect(buyer).dispute(0)).to.be.revertedWithCustomError(escrow, "WrongState").withArgs(st);
      await expect(escrow.connect(arbiter).resolve(0, false)).to.be.revertedWithCustomError(escrow, "WrongState").withArgs(st);
      await time.increase(60 * DAY);
      await expect(escrow.connect(seller).claimAfterDeadline(0)).to.be.revertedWithCustomError(escrow, "WrongState").withArgs(st);
      await expect(escrow.connect(buyer).refundAfterArbiterTimeout(0)).to.be.revertedWithCustomError(escrow, "WrongState").withArgs(st);
      expect(await escrow.owed(seller.address)).to.equal(2n * ONE);
      expect(await escrow.owed(buyer.address)).to.equal(0n);
    });

    it("a refunded deal cannot then be released by the arbiter", async function () {
      const { escrow, buyer, seller, arbiter } = await loadFixture(deploy);
      await escrow.connect(buyer).dispute(0);
      await escrow.connect(seller).refundBuyer(0); // seller gives in during the dispute
      await expect(escrow.connect(arbiter).resolve(0, true))
        .to.be.revertedWithCustomError(escrow, "WrongState").withArgs(S.Refunded);
    });

    it("a second withdraw pays nothing", async function () {
      const { escrow, buyer, seller } = await loadFixture(deploy);
      await escrow.connect(buyer).confirmDelivery(0);
      await escrow.connect(seller).withdraw();
      await expect(escrow.connect(seller).withdraw()).to.be.revertedWithCustomError(escrow, "NothingToWithdraw");
    });

    it("a seller contract that calls withdraw again while being paid gets paid once", async function () {
      const { escrow, buyer, arbiter } = await loadFixture(deploy);
      const sellerC = await ethers.deployContract("PartyContract", [await escrow.getAddress()]);
      await escrow.connect(buyer).openDeal(await sellerC.getAddress(), arbiter.address, DAY, { value: ONE });
      await escrow.connect(buyer).openDeal(await sellerC.getAddress(), arbiter.address, DAY, { value: ONE });
      await escrow.connect(buyer).confirmDelivery(1);
      await sellerC.setMode(false, true);
      await sellerC.withdraw();
      expect(await sellerC.received()).to.equal(ONE);
      expect(await sellerC.reentryFailed()).to.equal(true);
      // Deal 0 (2 ETH) and deal 2 (1 ETH) are still held, untouched.
      expect(await balanceOf(escrow)).to.equal(3n * ONE);
    });
  });

  describe("security: stuck funds", function () {
    it("buyer goes silent: the seller can claim only once the deadline has passed (exact second)", async function () {
      const { escrow, seller, deadline } = await loadFixture(deploy);
      await time.setNextBlockTimestamp(deadline - 1n);
      await expect(escrow.connect(seller).claimAfterDeadline(0)).to.be.revertedWithCustomError(escrow, "DeadlineNotPassed");
      await time.setNextBlockTimestamp(deadline);
      await expect(escrow.connect(seller).claimAfterDeadline(0))
        .to.emit(escrow, "Released").withArgs(0, seller.address, 2n * ONE, seller.address);
    });

    it("only the seller can claim after the deadline", async function () {
      const { escrow, buyer, arbiter, eve } = await loadFixture(deploy);
      await time.increase(15 * DAY);
      for (const who of [buyer, arbiter, eve]) {
        await expect(escrow.connect(who).claimAfterDeadline(0)).to.be.revertedWithCustomError(escrow, "NotSeller");
      }
    });

    it("disputes are only allowed before the deadline, so a late dispute cannot block the seller's claim", async function () {
      const { escrow, buyer, seller, deadline } = await loadFixture(deploy);
      await time.setNextBlockTimestamp(deadline);
      await expect(escrow.connect(buyer).dispute(0)).to.be.revertedWithCustomError(escrow, "DeadlinePassed");
      await expect(escrow.connect(seller).claimAfterDeadline(0)).to.emit(escrow, "Released");
    });

    it("a dispute at the last second still counts, and then the seller cannot claim", async function () {
      const { escrow, buyer, seller, deadline } = await loadFixture(deploy);
      await time.setNextBlockTimestamp(deadline - 1n);
      await expect(escrow.connect(buyer).dispute(0)).to.emit(escrow, "Disputed").withArgs(0, buyer.address);
      await expect(escrow.connect(seller).claimAfterDeadline(0))
        .to.be.revertedWithCustomError(escrow, "WrongState").withArgs(S.Disputed);
    });

    it("arbiter goes silent: after 30 days the buyer gets the money back (not one second earlier)", async function () {
      const { escrow, buyer, seller } = await loadFixture(deploy);
      await escrow.connect(seller).dispute(0);
      const at = (await escrow.getDeal(0)).disputedAt;
      await time.setNextBlockTimestamp(at + BigInt(30 * DAY) - 1n);
      await expect(escrow.connect(buyer).refundAfterArbiterTimeout(0)).to.be.revertedWithCustomError(escrow, "ArbiterStillHasTime");
      await time.setNextBlockTimestamp(at + BigInt(30 * DAY));
      await expect(escrow.connect(seller).refundAfterArbiterTimeout(0))
        .to.emit(escrow, "Refunded").withArgs(0, buyer.address, 2n * ONE, seller.address);
      await expect(escrow.connect(buyer).withdraw()).to.changeEtherBalance(buyer, 2n * ONE);
    });

    it("strangers and the arbiter cannot trigger the arbiter timeout", async function () {
      const { escrow, buyer, arbiter, eve } = await loadFixture(deploy);
      await escrow.connect(buyer).dispute(0);
      await time.increase(31 * DAY);
      for (const who of [arbiter, eve]) {
        await expect(escrow.connect(who).refundAfterArbiterTimeout(0)).to.be.revertedWithCustomError(escrow, "NotParty");
      }
    });

    it("the arbiter timeout needs a dispute first", async function () {
      const { escrow, buyer } = await loadFixture(deploy);
      await time.increase(60 * DAY);
      await expect(escrow.connect(buyer).refundAfterArbiterTimeout(0))
        .to.be.revertedWithCustomError(escrow, "WrongState").withArgs(S.Funded);
    });

    it("a seller contract that refuses ETH cannot block the deal from closing (pull payments)", async function () {
      const { escrow, buyer, arbiter } = await loadFixture(deploy);
      const sellerC = await ethers.deployContract("PartyContract", [await escrow.getAddress()]);
      await sellerC.setMode(true, false);
      await escrow.connect(buyer).openDeal(await sellerC.getAddress(), arbiter.address, DAY, { value: ONE });
      await expect(escrow.connect(buyer).confirmDelivery(1)).to.emit(escrow, "Released");
      // Only the refusing seller's own withdrawal fails; its credit stays recorded.
      await expect(sellerC.withdraw()).to.be.revertedWithCustomError(escrow, "TransferFailed");
      expect(await escrow.owed(await sellerC.getAddress())).to.equal(ONE);
    });

    it("a buyer contract that refuses ETH cannot block the arbiter's decision", async function () {
      const { escrow, seller, arbiter } = await loadFixture(deploy);
      const buyerC = await ethers.deployContract("PartyContract", [await escrow.getAddress()]);
      await buyerC.setMode(true, false);
      await buyerC.openDeal(seller.address, arbiter.address, DAY, { value: ONE });
      await buyerC.dispute(1);
      await expect(escrow.connect(arbiter).resolve(1, false)).to.emit(escrow, "Refunded");
      expect(await escrow.owed(await buyerC.getAddress())).to.equal(ONE);
    });

    it("ETH forced in with selfdestruct does not change any deal or anyone's credit", async function () {
      const { escrow, buyer, seller, eve } = await loadFixture(deploy);
      await ethers.deployContract("ForceSend", [await escrow.getAddress()], { value: 5n * ONE, signer: eve });
      expect(await balanceOf(escrow)).to.equal(7n * ONE);
      expect((await escrow.getDeal(0)).amount).to.equal(2n * ONE);
      await escrow.connect(buyer).confirmDelivery(0);
      await expect(escrow.connect(seller).withdraw()).to.changeEtherBalance(seller, 2n * ONE);
      expect(await escrow.owed(eve.address)).to.equal(0n);
    });

    it("one deal's seller cannot reach another deal's money", async function () {
      const { escrow, buyer, seller, arbiter, other } = await loadFixture(deploy);
      await escrow.connect(buyer).openDeal(other.address, arbiter.address, DAY, { value: 5n * ONE });
      await escrow.connect(buyer).confirmDelivery(0);
      await expect(escrow.connect(seller).withdraw()).to.changeEtherBalance(seller, 2n * ONE);
      await expect(escrow.connect(seller).claimAfterDeadline(1)).to.be.revertedWithCustomError(escrow, "NotSeller");
      expect((await escrow.getDeal(1)).amount).to.equal(5n * ONE);
      expect(await balanceOf(escrow)).to.equal(5n * ONE);
    });
  });

  describe("fuzz: random actions by everyone, random time jumps", function () {
    it("money is never created or lost, and every deal closes exactly once (60 random runs)", async function () {
      this.timeout(120000);
      const signers = await ethers.getSigners();
      const people = signers.slice(0, 5); // anyone can try anything
      const action = fc.record({
        kind: fc.constantFrom("open", "confirm", "refundBuyer", "dispute", "resolve", "claim", "timeout", "withdraw", "wait"),
        who: fc.nat(4),
        deal: fc.nat(3),
        flag: fc.boolean(),
        amount: fc.integer({ min: 1, max: 5 }),
        wait: fc.constantFrom(DAY, 7 * DAY, 20 * DAY, 31 * DAY),
      });

      await fc.assert(
        fc.asyncProperty(fc.array(action, { minLength: 5, maxLength: 25 }), async (actions) => {
          const escrow = await ethers.deployContract("Escrow");
          const addr = await escrow.getAddress();
          // Model: deals and owed credits in plain JavaScript.
          const deals = [];
          const owed = new Map(people.map((p) => [p.address, 0n]));
          const closeCount = [];
          const send = async (tx) => { try { await tx; return true; } catch { return false; } };

          for (const a of actions) {
            const p = people[a.who];
            const d = deals[a.deal];
            const now = BigInt(await time.latest()) + 1n; // timestamp of the next block
            switch (a.kind) {
              case "open": {
                const seller = people[(a.who + 1) % 5], arbiter = people[(a.who + 2) % 5];
                const ok = await send(escrow.connect(p).openDeal(seller.address, arbiter.address, 14 * DAY, { value: BigInt(a.amount) * ONE }));
                expect(ok).to.equal(true);
                deals.push({ buyer: p.address, seller: seller.address, arbiter: arbiter.address, amount: BigInt(a.amount) * ONE, state: "Funded", deadline: now + BigInt(14 * DAY), disputedAt: 0n });
                closeCount.push(0);
                break;
              }
              case "confirm": case "refundBuyer": case "dispute": case "resolve": case "claim": case "timeout": {
                if (!d) break;
                const open = d.state === "Funded" || d.state === "Disputed";
                let expectOk, toSeller;
                if (a.kind === "confirm") { expectOk = p.address === d.buyer && open; toSeller = true; }
                if (a.kind === "refundBuyer") { expectOk = p.address === d.seller && open; toSeller = false; }
                if (a.kind === "dispute") expectOk = (p.address === d.buyer || p.address === d.seller) && d.state === "Funded" && now < d.deadline;
                if (a.kind === "resolve") { expectOk = p.address === d.arbiter && d.state === "Disputed"; toSeller = a.flag; }
                if (a.kind === "claim") { expectOk = p.address === d.seller && d.state === "Funded" && now >= d.deadline; toSeller = true; }
                if (a.kind === "timeout") { expectOk = (p.address === d.buyer || p.address === d.seller) && d.state === "Disputed" && now >= d.disputedAt + BigInt(30 * DAY); toSeller = false; }
                const c = escrow.connect(p);
                const tx = { confirm: () => c.confirmDelivery(a.deal), refundBuyer: () => c.refundBuyer(a.deal), dispute: () => c.dispute(a.deal),
                  resolve: () => c.resolve(a.deal, a.flag), claim: () => c.claimAfterDeadline(a.deal), timeout: () => c.refundAfterArbiterTimeout(a.deal) }[a.kind];
                const ok = await send(tx());
                expect(ok, `${a.kind} by ${a.who} on deal ${a.deal}`).to.equal(expectOk);
                if (!ok) break;
                if (a.kind === "dispute") { d.state = "Disputed"; d.disputedAt = now; break; }
                d.state = toSeller ? "Released" : "Refunded";
                const to = toSeller ? d.seller : d.buyer;
                owed.set(to, owed.get(to) + d.amount);
                closeCount[a.deal] += 1;
                break;
              }
              case "withdraw": {
                const ok = await send(escrow.connect(p).withdraw());
                expect(ok).to.equal(owed.get(p.address) > 0n);
                owed.set(p.address, 0n);
                break;
              }
              case "wait":
                await time.increase(a.wait);
                break;
            }

            // Invariants after every step.
            const held = deals.filter((x) => x.state === "Funded" || x.state === "Disputed").reduce((s, x) => s + x.amount, 0n);
            const credits = [...owed.values()].reduce((s, v) => s + v, 0n);
            expect(await ethers.provider.getBalance(addr)).to.equal(held + credits); // the contract holds exactly what it owes
            for (const person of people) expect(await escrow.owed(person.address)).to.equal(owed.get(person.address));
            for (let i = 0; i < deals.length; i++) {
              expect(closeCount[i]).to.be.at.most(1); // closed at most once
              expect((await escrow.getDeal(i)).state).to.equal(S[deals[i].state]);
            }
          }
        }),
        { numRuns: 60 }
      );
    });
  });
});
