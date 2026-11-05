const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const fc = require("fast-check");

const ONE = ethers.parseEther("1");
const DAY = 24 * 60 * 60;

describe("CrowdFund", function () {
  // Campaign 0: creator asks for 10 ETH over 7 days.
  async function deploy() {
    const [creator, alice, bob, carol, eve, other] = await ethers.getSigners();
    const fund = await ethers.deployContract("CrowdFund");
    await fund.connect(creator).launch(10n * ONE, 7 * DAY);
    const c = await fund.getCampaign(0);
    return { fund, creator, alice, bob, carol, eve, other, endAt: c.endAt };
  }

  const fundAddr = (fund) => fund.getAddress();
  const balanceOf = async (fund) => ethers.provider.getBalance(await fundAddr(fund));

  describe("launch", function () {
    it("stores the creator, goal and deadline and emits Launched", async function () {
      const { fund, creator } = await loadFixture(deploy);
      const now = await time.latest();
      await expect(fund.connect(creator).launch(5n * ONE, DAY))
        .to.emit(fund, "Launched")
        .withArgs(1, creator.address, 5n * ONE, now + 1 + DAY);
      const c = await fund.getCampaign(1);
      expect(c.creator).to.equal(creator.address);
      expect(c.goal).to.equal(5n * ONE);
      expect(c.pledged).to.equal(0n);
      expect(await fund.campaignCount()).to.equal(2n);
    });

    it("rejects a zero goal, a too short or too long duration and unknown ids", async function () {
      const { fund } = await loadFixture(deploy);
      await expect(fund.launch(0, DAY)).to.be.revertedWithCustomError(fund, "ZeroGoal");
      await expect(fund.launch(ONE, 60)).to.be.revertedWithCustomError(fund, "BadDuration");
      await expect(fund.launch(ONE, 91 * DAY)).to.be.revertedWithCustomError(fund, "BadDuration");
      await expect(fund.getCampaign(9)).to.be.revertedWithCustomError(fund, "UnknownCampaign");
      await expect(fund.pledge(9, { value: ONE })).to.be.revertedWithCustomError(fund, "UnknownCampaign");
      await expect(fund.refund(9)).to.be.revertedWithCustomError(fund, "UnknownCampaign");
    });
  });

  describe("pledge and unpledge", function () {
    it("records each backer's pledge and the campaign total", async function () {
      const { fund, alice, bob } = await loadFixture(deploy);
      await expect(fund.connect(alice).pledge(0, { value: 3n * ONE }))
        .to.emit(fund, "Pledged").withArgs(0, alice.address, 3n * ONE);
      await fund.connect(alice).pledge(0, { value: ONE });
      await fund.connect(bob).pledge(0, { value: 2n * ONE });
      expect(await fund.pledgeOf(0, alice.address)).to.equal(4n * ONE);
      expect((await fund.getCampaign(0)).pledged).to.equal(6n * ONE);
      expect(await balanceOf(fund)).to.equal(6n * ONE);
    });

    it("rejects zero pledges and pledges at or after the deadline", async function () {
      const { fund, alice, endAt } = await loadFixture(deploy);
      await expect(fund.connect(alice).pledge(0)).to.be.revertedWithCustomError(fund, "ZeroAmount");
      await time.setNextBlockTimestamp(endAt - 1n);
      await fund.connect(alice).pledge(0, { value: ONE }); // last second still counts
      await time.setNextBlockTimestamp(endAt);
      await expect(fund.connect(alice).pledge(0, { value: ONE })).to.be.revertedWithCustomError(fund, "CampaignEnded");
    });

    it("a backer can take part of a pledge back before the deadline, never more than they put in", async function () {
      const { fund, alice, bob } = await loadFixture(deploy);
      await fund.connect(alice).pledge(0, { value: 3n * ONE });
      await fund.connect(bob).pledge(0, { value: 3n * ONE });
      await expect(fund.connect(alice).unpledge(0, ONE)).to.changeEtherBalances([alice, fund], [ONE, -ONE]);
      await expect(fund.connect(alice).unpledge(0, 3n * ONE)).to.be.revertedWithCustomError(fund, "NotEnoughPledged");
      await expect(fund.connect(alice).unpledge(0, 0)).to.be.revertedWithCustomError(fund, "ZeroAmount");
      expect((await fund.getCampaign(0)).pledged).to.equal(5n * ONE);
    });

    it("no unpledge after the deadline", async function () {
      const { fund, alice } = await loadFixture(deploy);
      await fund.connect(alice).pledge(0, { value: ONE });
      await time.increase(7 * DAY);
      await expect(fund.connect(alice).unpledge(0, ONE)).to.be.revertedWithCustomError(fund, "CampaignEnded");
    });

    it("plain ETH sent to the contract is refused", async function () {
      const { fund, alice } = await loadFixture(deploy);
      await expect(alice.sendTransaction({ to: await fundAddr(fund), value: ONE }))
        .to.be.revertedWithCustomError(fund, "DirectPaymentRejected");
    });
  });

  describe("success: the creator claims", function () {
    it("pays the creator the full total once the deadline passes with the goal reached", async function () {
      const { fund, creator, alice, bob } = await loadFixture(deploy);
      await fund.connect(alice).pledge(0, { value: 6n * ONE });
      await fund.connect(bob).pledge(0, { value: 5n * ONE });
      await time.increase(7 * DAY);
      const tx = fund.connect(creator).claim(0);
      await expect(tx).to.emit(fund, "Claimed").withArgs(0, creator.address, 11n * ONE);
      await expect(tx).to.changeEtherBalances([creator, fund], [11n * ONE, -11n * ONE]);
      expect((await fund.getCampaign(0)).claimed).to.equal(true);
    });

    it("the creator cannot claim before the deadline, even when the goal is already reached", async function () {
      const { fund, creator, alice } = await loadFixture(deploy);
      await fund.connect(alice).pledge(0, { value: 10n * ONE });
      await expect(fund.connect(creator).claim(0)).to.be.revertedWithCustomError(fund, "CampaignNotEnded");
    });

    it("the creator cannot claim when the goal was missed", async function () {
      const { fund, creator, alice } = await loadFixture(deploy);
      await fund.connect(alice).pledge(0, { value: 9n * ONE });
      await time.increase(7 * DAY);
      await expect(fund.connect(creator).claim(0)).to.be.revertedWithCustomError(fund, "GoalNotReached");
    });

    it("backers cannot refund a successful campaign", async function () {
      const { fund, alice } = await loadFixture(deploy);
      await fund.connect(alice).pledge(0, { value: 10n * ONE });
      await time.increase(7 * DAY);
      await expect(fund.connect(alice).refund(0)).to.be.revertedWithCustomError(fund, "GoalReached");
    });
  });

  describe("failure: backers pull their own refunds", function () {
    it("each backer gets back exactly what they pledged", async function () {
      const { fund, alice, bob } = await loadFixture(deploy);
      await fund.connect(alice).pledge(0, { value: 4n * ONE });
      await fund.connect(bob).pledge(0, { value: 2n * ONE });
      await time.increase(7 * DAY);
      const tx = fund.connect(alice).refund(0);
      await expect(tx).to.emit(fund, "Refunded").withArgs(0, alice.address, 4n * ONE);
      await expect(tx).to.changeEtherBalances([alice, fund], [4n * ONE, -4n * ONE]);
      await expect(fund.connect(bob).refund(0)).to.changeEtherBalances([bob, fund], [2n * ONE, -2n * ONE]);
      expect(await balanceOf(fund)).to.equal(0n);
    });

    it("no refunds while the campaign is still running", async function () {
      const { fund, alice, endAt } = await loadFixture(deploy);
      await fund.connect(alice).pledge(0, { value: ONE });
      await time.setNextBlockTimestamp(endAt - 1n);
      await expect(fund.connect(alice).refund(0)).to.be.revertedWithCustomError(fund, "CampaignNotEnded");
    });

    it("someone who never pledged gets nothing", async function () {
      const { fund, alice, eve } = await loadFixture(deploy);
      await fund.connect(alice).pledge(0, { value: ONE });
      await time.increase(7 * DAY);
      await expect(fund.connect(eve).refund(0)).to.be.revertedWithCustomError(fund, "NothingToRefund");
    });

    it("a cancelled campaign refunds at once and can never be claimed", async function () {
      const { fund, creator, alice, eve } = await loadFixture(deploy);
      await fund.connect(alice).pledge(0, { value: 10n * ONE });
      await expect(fund.connect(eve).cancel(0)).to.be.revertedWithCustomError(fund, "NotCreator");
      await expect(fund.connect(creator).cancel(0)).to.emit(fund, "Cancelled").withArgs(0);
      await expect(fund.connect(creator).cancel(0)).to.be.revertedWithCustomError(fund, "CampaignCancelled");
      await expect(fund.connect(alice).pledge(0, { value: ONE })).to.be.revertedWithCustomError(fund, "CampaignCancelled");
      await expect(fund.connect(alice).unpledge(0, ONE)).to.be.revertedWithCustomError(fund, "CampaignCancelled");
      await expect(fund.connect(alice).refund(0)).to.changeEtherBalance(alice, 10n * ONE);
      await time.increase(7 * DAY);
      await expect(fund.connect(creator).claim(0)).to.be.revertedWithCustomError(fund, "CampaignCancelled");
    });

    it("the creator cannot cancel after the deadline (a successful campaign stays successful)", async function () {
      const { fund, creator, alice } = await loadFixture(deploy);
      await fund.connect(alice).pledge(0, { value: 10n * ONE });
      await time.increase(7 * DAY);
      await expect(fund.connect(creator).cancel(0)).to.be.revertedWithCustomError(fund, "CampaignEnded");
    });
  });

  describe("security: claiming twice", function () {
    it("a second claim fails and pays nothing", async function () {
      const { fund, creator, alice } = await loadFixture(deploy);
      await fund.connect(alice).pledge(0, { value: 10n * ONE });
      await time.increase(7 * DAY);
      await fund.connect(creator).claim(0);
      await expect(fund.connect(creator).claim(0)).to.be.revertedWithCustomError(fund, "AlreadyClaimed");
    });

    it("only the creator can claim", async function () {
      const { fund, alice, eve } = await loadFixture(deploy);
      await fund.connect(alice).pledge(0, { value: 10n * ONE });
      await time.increase(7 * DAY);
      await expect(fund.connect(eve).claim(0)).to.be.revertedWithCustomError(fund, "NotCreator");
      await expect(fund.connect(alice).claim(0)).to.be.revertedWithCustomError(fund, "NotCreator");
    });

    it("a creator contract that calls claim again while being paid gets paid once", async function () {
      const { fund, alice } = await loadFixture(deploy);
      const actor = await ethers.deployContract("ReentrantActor", [await fundAddr(fund)]);
      await actor.launch(5n * ONE, DAY);
      const id = await actor.id();
      await fund.connect(alice).pledge(id, { value: 5n * ONE });
      await time.increase(DAY);
      await actor.attack(2);
      expect(await actor.reentryFailed()).to.equal(true);
      expect(await actor.received()).to.equal(5n * ONE);
    });

    it("a creator cannot drain another campaign's money", async function () {
      const { fund, creator, alice, bob } = await loadFixture(deploy);
      await fund.connect(bob).launch(ONE, DAY); // campaign 1
      await fund.connect(bob).pledge(1, { value: ONE });
      await fund.connect(alice).pledge(0, { value: 9n * ONE }); // campaign 0 fails
      await time.increase(7 * DAY);
      await expect(fund.connect(bob).claim(1)).to.changeEtherBalance(bob, ONE);
      await expect(fund.connect(bob).claim(1)).to.be.revertedWithCustomError(fund, "AlreadyClaimed");
      await expect(fund.connect(creator).claim(0)).to.be.revertedWithCustomError(fund, "GoalNotReached");
      await expect(fund.connect(alice).refund(0)).to.changeEtherBalance(alice, 9n * ONE);
    });
  });

  describe("security: refunds", function () {
    it("a second refund fails and pays nothing", async function () {
      const { fund, alice } = await loadFixture(deploy);
      await fund.connect(alice).pledge(0, { value: 2n * ONE });
      await time.increase(7 * DAY);
      await fund.connect(alice).refund(0);
      await expect(fund.connect(alice).refund(0)).to.be.revertedWithCustomError(fund, "NothingToRefund");
    });

    it("a backer contract that calls refund again while being paid gets paid once", async function () {
      const { fund, alice } = await loadFixture(deploy);
      const actor = await ethers.deployContract("ReentrantActor", [await fundAddr(fund)]);
      await actor.pledge(0, { value: 2n * ONE });
      await fund.connect(alice).pledge(0, { value: 3n * ONE });
      await time.increase(7 * DAY);
      await actor.attack(1);
      expect(await actor.reentryFailed()).to.equal(true);
      expect(await actor.received()).to.equal(2n * ONE);
      expect(await balanceOf(fund)).to.equal(3n * ONE); // alice's money is untouched
      await expect(fund.connect(alice).refund(0)).to.changeEtherBalance(alice, 3n * ONE);
    });

    it("a backer contract that calls unpledge again while being paid cannot take more", async function () {
      const { fund, alice } = await loadFixture(deploy);
      const actor = await ethers.deployContract("ReentrantActor", [await fundAddr(fund)]);
      await actor.pledge(0, { value: ONE });
      await fund.connect(alice).pledge(0, { value: 3n * ONE });
      await actor.attack(3);
      expect(await actor.reentryFailed()).to.equal(true);
      expect(await actor.received()).to.equal(ONE);
      expect(await balanceOf(fund)).to.equal(3n * ONE);
    });

    it("a backer that refuses ETH cannot block anyone else's refund (no refund loop)", async function () {
      const { fund, alice, bob } = await loadFixture(deploy);
      const bad = await ethers.deployContract("RejectingBacker");
      await bad.pledge(await fundAddr(fund), 0, { value: ONE });
      await fund.connect(alice).pledge(0, { value: 2n * ONE });
      await fund.connect(bob).pledge(0, { value: 3n * ONE });
      await time.increase(7 * DAY);
      await expect(bad.refund(await fundAddr(fund), 0)).to.be.revertedWithCustomError(fund, "TransferFailed");
      await expect(fund.connect(alice).refund(0)).to.changeEtherBalance(alice, 2n * ONE);
      await expect(fund.connect(bob).refund(0)).to.changeEtherBalance(bob, 3n * ONE);
      expect(await fund.pledgeOf(0, await bad.getAddress())).to.equal(ONE); // still owed, never lost
    });

    it("refund gas stays the same with 1 backer or 40 backers", async function () {
      const { fund, alice } = await loadFixture(deploy);
      const signers = (await ethers.getSigners()).slice(6, 46);
      for (const s of signers) await fund.connect(s).pledge(0, { value: ONE / 100n });
      await fund.connect(alice).pledge(0, { value: ONE });
      await time.increase(7 * DAY);
      const first = await (await fund.connect(signers[0]).refund(0)).wait();
      const last = await (await fund.connect(alice).refund(0)).wait();
      expect(last.gasUsed).to.be.closeTo(first.gasUsed, 100n);
    });

    it("ETH forced in with selfdestruct does not change any campaign's numbers", async function () {
      const { fund, alice } = await loadFixture(deploy);
      await fund.connect(alice).pledge(0, { value: 9n * ONE });
      await ethers.deployContract("ForceSender", [await fundAddr(fund)], { value: 5n * ONE });
      expect(await balanceOf(fund)).to.equal(14n * ONE);
      await time.increase(7 * DAY);
      // 14 ETH sits in the contract, but campaign 0 only raised 9: still a failure, refunds open.
      await expect(fund.claim(0)).to.be.revertedWithCustomError(fund, "GoalNotReached");
      await expect(fund.connect(alice).refund(0)).to.changeEtherBalance(alice, 9n * ONE);
    });
  });

  describe("fuzz: random pledges, unpledges, time jumps, claims and refunds", function () {
    it("money is never created or lost and each campaign pays out one way only (50 random runs)", async function () {
      const { fund, creator, alice, bob, carol, eve } = await loadFixture(deploy);
      const backers = [alice, bob, carol, eve];
      await fund.connect(creator).launch(3n * ONE, 7 * DAY); // campaign 1: small goal
      const goals = [10n * ONE, 3n * ONE];
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              op: fc.constantFrom("pledge", "pledge", "unpledge", "claim", "refund", "wait"),
              who: fc.nat(3),
              id: fc.nat(1),
              amount: fc.integer({ min: 1, max: 4 }),
            }),
            { minLength: 5, maxLength: 30 }
          ),
          async (steps) => {
            const snap = await ethers.provider.send("evm_snapshot", []);
            const ends = [(await fund.getCampaign(0)).endAt, (await fund.getCampaign(1)).endAt];
            const pledges = [new Map(), new Map()];
            const total = [0n, 0n];
            const claimed = [false, false];
            let refunded = [0n, 0n];
            for (const { op, who, id, amount } of steps) {
              const now = BigInt(await time.latest()) + 1n; // timestamp of the next block
              const ended = now >= ends[id];
              const s = backers[who];
              const mine = pledges[id].get(who) || 0n;
              const value = BigInt(amount) * ONE;
              let expectOk;
              let tx;
              if (op === "wait") {
                await time.increase(3 * DAY);
                continue;
              } else if (op === "pledge") {
                expectOk = !ended;
                tx = () => fund.connect(s).pledge(id, { value });
              } else if (op === "unpledge") {
                expectOk = !ended && value <= mine;
                tx = () => fund.connect(s).unpledge(id, value);
              } else if (op === "claim") {
                expectOk = ended && total[id] >= goals[id] && !claimed[id];
                tx = () => fund.connect(creator).claim(id);
              } else {
                expectOk = ended && total[id] < goals[id] && mine > 0n;
                tx = () => fund.connect(s).refund(id);
              }
              let ok = true;
              try { await (await tx()).wait(); } catch { ok = false; }
              expect(ok).to.equal(expectOk, `${op} by ${who} on ${id}`);
              if (!ok) continue;
              if (op === "pledge") { pledges[id].set(who, mine + value); total[id] += value; }
              if (op === "unpledge") { pledges[id].set(who, mine - value); total[id] -= value; }
              if (op === "claim") claimed[id] = true;
              if (op === "refund") { pledges[id].set(who, 0n); total[id] -= mine; refunded[id] += mine; }
            }
            // Invariants
            let held = 0n;
            for (const id of [0, 1]) {
              const c = await fund.getCampaign(id);
              expect(c.pledged).to.equal(total[id]);
              expect(c.claimed).to.equal(claimed[id]);
              expect(claimed[id] && refunded[id] > 0n).to.equal(false); // never both
              for (let w = 0; w < 4; w++) {
                expect(await fund.pledgeOf(id, backers[w].address)).to.equal(pledges[id].get(w) || 0n);
              }
              if (!claimed[id]) held += total[id];
            }
            expect(await balanceOf(fund)).to.equal(held); // the contract holds exactly what it owes
            await ethers.provider.send("evm_revert", [snap]);
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});
