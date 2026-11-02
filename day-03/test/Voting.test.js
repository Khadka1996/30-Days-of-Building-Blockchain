const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const fc = require("fast-check");

const MINUTE = 60;
const DAY = 24 * 60 * MINUTE;
const Status = { None: 0, Open: 1, Ended: 2, Cancelled: 3 };
const Outcome = { NoVotes: 0, Winner: 1, Tie: 2 };

const QUESTION = "Best momo filling?";
const OPTIONS = ["Buff", "Chicken", "Veg"];

describe("Voting", function () {
  async function deploy() {
    const signers = await ethers.getSigners();
    const [alice, bob, carol, dave] = signers;
    const voting = await ethers.deployContract("Voting");
    return { voting, alice, bob, carol, dave, signers };
  }

  // A deployed contract with one open poll (id 1) that closes in 3 days.
  async function deployWithPoll() {
    const base = await deploy();
    const deadline = (await time.latest()) + 3 * DAY;
    await base.voting.createPoll(QUESTION, OPTIONS, deadline);
    return { ...base, pollId: 1n, deadline };
  }

  describe("creating a poll", function () {
    it("stores the poll, emits PollCreated and starts ids at 1", async function () {
      const { voting, alice } = await loadFixture(deploy);
      const deadline = (await time.latest()) + 3 * DAY;
      await expect(voting.createPoll(QUESTION, OPTIONS, deadline))
        .to.emit(voting, "PollCreated")
        .withArgs(1, alice.address, QUESTION, 3, deadline);

      const p = await voting.getPoll(1);
      expect(p.creator).to.equal(alice.address);
      expect(p.question).to.equal(QUESTION);
      expect(p.options).to.deep.equal(OPTIONS);
      expect(p.votes).to.deep.equal([0n, 0n, 0n]);
      expect(p.deadline).to.equal(deadline);
      expect(p.currentStatus).to.equal(Status.Open);
      expect(await voting.pollCount()).to.equal(1);
    });

    it("rejects an empty or too long question", async function () {
      const { voting } = await loadFixture(deploy);
      const deadline = (await time.latest()) + DAY;
      await expect(voting.createPoll("", OPTIONS, deadline)).to.be.revertedWithCustomError(voting, "EmptyQuestion");
      await expect(voting.createPoll("q".repeat(201), OPTIONS, deadline))
        .to.be.revertedWithCustomError(voting, "QuestionTooLong").withArgs(201);
      await expect(voting.createPoll("q".repeat(200), OPTIONS, deadline)).to.not.be.reverted;
    });

    it("needs 2 to 10 options (keeps the result loop small)", async function () {
      const { voting } = await loadFixture(deploy);
      const deadline = (await time.latest()) + DAY;
      const many = (n) => Array.from({ length: n }, (_, i) => `Option ${i}`);
      await expect(voting.createPoll(QUESTION, many(1), deadline))
        .to.be.revertedWithCustomError(voting, "BadOptionCount").withArgs(1);
      await expect(voting.createPoll(QUESTION, many(11), deadline))
        .to.be.revertedWithCustomError(voting, "BadOptionCount").withArgs(11);
      await expect(voting.createPoll(QUESTION, many(2), deadline)).to.not.be.reverted;
      await expect(voting.createPoll(QUESTION, many(10), deadline)).to.not.be.reverted;
    });

    it("rejects empty or too long option text", async function () {
      const { voting } = await loadFixture(deploy);
      const deadline = (await time.latest()) + DAY;
      await expect(voting.createPoll(QUESTION, ["Yes", ""], deadline))
        .to.be.revertedWithCustomError(voting, "EmptyOption").withArgs(1);
      await expect(voting.createPoll(QUESTION, ["x".repeat(51), "No"], deadline))
        .to.be.revertedWithCustomError(voting, "OptionTooLong").withArgs(0, 51);
    });

    it("needs a deadline 5 minutes to 30 days away (catches milliseconds)", async function () {
      const { voting } = await loadFixture(deploy);
      const now = await time.latest();
      // The next transaction is mined 1 second after `now`.
      await expect(voting.createPoll(QUESTION, OPTIONS, now))
        .to.be.revertedWithCustomError(voting, "BadDeadline");
      await expect(voting.createPoll(QUESTION, OPTIONS, now + 4 * MINUTE))
        .to.be.revertedWithCustomError(voting, "BadDeadline");
      await expect(voting.createPoll(QUESTION, OPTIONS, (now + DAY) * 1000))
        .to.be.revertedWithCustomError(voting, "BadDeadline");
      await expect(voting.createPoll(QUESTION, OPTIONS, now + 31 * DAY))
        .to.be.revertedWithCustomError(voting, "BadDeadline");
      await expect(voting.createPoll(QUESTION, OPTIONS, now + 1 + 30 * DAY)).to.not.be.reverted;
    });

    it("unknown poll ids are reported as None / PollNotFound", async function () {
      const { voting } = await loadFixture(deployWithPoll);
      expect(await voting.status(0)).to.equal(Status.None);
      expect(await voting.status(2)).to.equal(Status.None);
      await expect(voting.vote(0, 0)).to.be.revertedWithCustomError(voting, "PollNotFound").withArgs(0);
      await expect(voting.vote(2, 0)).to.be.revertedWithCustomError(voting, "PollNotFound").withArgs(2);
      await expect(voting.getResult(2)).to.be.revertedWithCustomError(voting, "PollNotFound");
      await expect(voting.getPoll(2)).to.be.revertedWithCustomError(voting, "PollNotFound");
    });
  });

  describe("voting", function () {
    it("counts a vote, marks the voter and emits Voted", async function () {
      const { voting, pollId, bob } = await loadFixture(deployWithPoll);
      await expect(voting.connect(bob).vote(pollId, 1))
        .to.emit(voting, "Voted").withArgs(pollId, bob.address, 1);
      const p = await voting.getPoll(pollId);
      expect(p.votes).to.deep.equal([0n, 1n, 0n]);
      expect(p.totalVotes).to.equal(1);
      expect(await voting.hasVoted(pollId, bob.address)).to.equal(true);
    });

    it("rejects an option that does not exist", async function () {
      const { voting, pollId } = await loadFixture(deployWithPoll);
      await expect(voting.vote(pollId, 3))
        .to.be.revertedWithCustomError(voting, "InvalidOption").withArgs(3, 3);
    });

    it("voting in one poll does not use up your vote in another", async function () {
      const { voting, bob } = await loadFixture(deployWithPoll);
      await voting.createPoll("Tea or coffee?", ["Tea", "Coffee"], (await time.latest()) + DAY);
      await voting.connect(bob).vote(1, 0);
      await expect(voting.connect(bob).vote(2, 1)).to.not.be.reverted;
    });
  });

  describe("security: double voting", function () {
    it("the same address cannot vote twice, even for the same option", async function () {
      const { voting, pollId, bob } = await loadFixture(deployWithPoll);
      await voting.connect(bob).vote(pollId, 0);
      await expect(voting.connect(bob).vote(pollId, 0))
        .to.be.revertedWithCustomError(voting, "AlreadyVoted").withArgs(pollId, bob.address);
    });

    it("a vote cannot be changed", async function () {
      const { voting, pollId, bob } = await loadFixture(deployWithPoll);
      await voting.connect(bob).vote(pollId, 0);
      await expect(voting.connect(bob).vote(pollId, 2))
        .to.be.revertedWithCustomError(voting, "AlreadyVoted");
      expect((await voting.getPoll(pollId)).votes).to.deep.equal([1n, 0n, 0n]);
    });

    it("the poll creator gets exactly one vote like everyone else", async function () {
      const { voting, pollId, alice } = await loadFixture(deployWithPoll);
      await voting.connect(alice).vote(pollId, 0);
      await expect(voting.connect(alice).vote(pollId, 0))
        .to.be.revertedWithCustomError(voting, "AlreadyVoted");
    });
  });

  describe("security: deadline", function () {
    it("accepts a vote 1 second before the deadline, refuses one exactly at it", async function () {
      const { voting, pollId, deadline, bob, carol } = await loadFixture(deployWithPoll);
      await time.setNextBlockTimestamp(deadline - 1);
      await expect(voting.connect(bob).vote(pollId, 0)).to.not.be.reverted;
      await time.setNextBlockTimestamp(deadline);
      await expect(voting.connect(carol).vote(pollId, 1))
        .to.be.revertedWithCustomError(voting, "PollNotOpen").withArgs(pollId, Status.Ended);
    });

    it("the result is not available while voting is still open", async function () {
      const { voting, pollId, deadline } = await loadFixture(deployWithPoll);
      await expect(voting.getResult(pollId))
        .to.be.revertedWithCustomError(voting, "ResultNotReady").withArgs(pollId, Status.Open);
      await time.increaseTo(deadline - 1);
      await expect(voting.getResult(pollId)).to.be.revertedWithCustomError(voting, "ResultNotReady");
      await time.increaseTo(deadline);
      await expect(voting.getResult(pollId)).to.not.be.reverted;
    });

    it("there is no second where you can vote AND read the final result", async function () {
      const { voting, pollId, deadline } = await loadFixture(deployWithPoll);
      await time.increaseTo(deadline - 1);
      expect(await voting.status(pollId)).to.equal(Status.Open);
      await time.increaseTo(deadline);
      expect(await voting.status(pollId)).to.equal(Status.Ended);
    });
  });

  describe("results", function () {
    async function voteAll(voting, pollId, signers, choices) {
      for (let i = 0; i < choices.length; i++) await voting.connect(signers[i]).vote(pollId, choices[i]);
    }

    it("shows the winner after the deadline", async function () {
      const { voting, pollId, deadline, signers } = await loadFixture(deployWithPoll);
      await voteAll(voting, pollId, signers, [1, 1, 0, 2, 1]);
      await time.increaseTo(deadline);
      const [outcome, winner, top] = await voting.getResult(pollId);
      expect([Number(outcome), Number(winner), Number(top)]).to.deep.equal([Outcome.Winner, 1, 3]);
    });

    it("reports a tie instead of silently picking the first option", async function () {
      const { voting, pollId, deadline, signers } = await loadFixture(deployWithPoll);
      await voteAll(voting, pollId, signers, [0, 2, 2, 0]);
      await time.increaseTo(deadline);
      const [outcome, , top] = await voting.getResult(pollId);
      expect(Number(outcome)).to.equal(Outcome.Tie);
      expect(top).to.equal(2);
    });

    it("a winner in the last option is found too", async function () {
      const { voting, pollId, deadline, signers } = await loadFixture(deployWithPoll);
      await voteAll(voting, pollId, signers, [2]);
      await time.increaseTo(deadline);
      const [outcome, winner] = await voting.getResult(pollId);
      expect([Number(outcome), Number(winner)]).to.deep.equal([Outcome.Winner, 2]);
    });

    it("reports NoVotes when nobody voted", async function () {
      const { voting, pollId, deadline } = await loadFixture(deployWithPoll);
      await time.increaseTo(deadline);
      const [outcome, , top] = await voting.getResult(pollId);
      expect(Number(outcome)).to.equal(Outcome.NoVotes);
      expect(top).to.equal(0);
    });
  });

  describe("security: cancelling", function () {
    it("the creator can cancel before any votes; then nobody can vote or read a result", async function () {
      const { voting, pollId, deadline, bob } = await loadFixture(deployWithPoll);
      await expect(voting.cancelPoll(pollId)).to.emit(voting, "PollCancelled").withArgs(pollId);
      expect(await voting.status(pollId)).to.equal(Status.Cancelled);
      await expect(voting.connect(bob).vote(pollId, 0))
        .to.be.revertedWithCustomError(voting, "PollNotOpen").withArgs(pollId, Status.Cancelled);
      await time.increaseTo(deadline);
      await expect(voting.getResult(pollId))
        .to.be.revertedWithCustomError(voting, "ResultNotReady").withArgs(pollId, Status.Cancelled);
    });

    it("only the creator can cancel", async function () {
      const { voting, pollId, bob } = await loadFixture(deployWithPoll);
      await expect(voting.connect(bob).cancelPoll(pollId))
        .to.be.revertedWithCustomError(voting, "NotCreator").withArgs(pollId);
    });

    it("the creator cannot cancel once someone has voted (no throwing away a losing poll)", async function () {
      const { voting, pollId, bob } = await loadFixture(deployWithPoll);
      await voting.connect(bob).vote(pollId, 2);
      await expect(voting.cancelPoll(pollId))
        .to.be.revertedWithCustomError(voting, "CannotCancelAfterVotes").withArgs(pollId, 1);
    });

    it("the creator cannot cancel after the deadline or cancel twice", async function () {
      const { voting, pollId, deadline } = await loadFixture(deployWithPoll);
      await voting.cancelPoll(pollId);
      await expect(voting.cancelPoll(pollId)).to.be.revertedWithCustomError(voting, "PollNotOpen");

      const d2 = (await time.latest()) + DAY;
      await voting.createPoll("Tea or coffee?", ["Tea", "Coffee"], d2);
      await time.increaseTo(Math.max(d2, deadline));
      await expect(voting.cancelPoll(2))
        .to.be.revertedWithCustomError(voting, "PollNotOpen").withArgs(2, Status.Ended);
    });
  });

  describe("fuzz: random voters, choices and time jumps", function () {
    it("counts always match a simple model, nobody votes twice (50 random runs)", async function () {
      const { signers } = await loadFixture(deploy);
      const voters = signers.slice(0, 8);

      const action = fc.oneof(
        fc.record({ kind: fc.constant("vote"), poll: fc.integer({ min: 1, max: 2 }), who: fc.integer({ min: 0, max: 7 }), option: fc.integer({ min: 0, max: 3 }) }),
        fc.record({ kind: fc.constant("wait"), hours: fc.integer({ min: 1, max: 40 }) })
      );

      await fc.assert(
        fc.asyncProperty(fc.array(action, { minLength: 1, maxLength: 25 }), async (actions) => {
          const voting = await ethers.deployContract("Voting");
          const start = await time.latest();
          const polls = {
            1: { deadline: start + 2 * DAY, options: 3 },
            2: { deadline: start + 3 * DAY, options: 2 },
          };
          await voting.createPoll("Poll one", ["A", "B", "C"], polls[1].deadline);
          await voting.createPoll("Poll two", ["Yes", "No"], polls[2].deadline);
          const model = { 1: { votes: [0, 0, 0], voted: new Set() }, 2: { votes: [0, 0], voted: new Set() } };

          for (const a of actions) {
            if (a.kind === "wait") {
              await time.increase(a.hours * 3600);
              continue;
            }
            const voter = voters[a.who];
            const p = polls[a.poll];
            const m = model[a.poll];
            // Predict whether the vote should work, using the block it will be mined in.
            const nextTs = (await time.latest()) + 1;
            const shouldWork = nextTs < p.deadline && !m.voted.has(a.who) && a.option < p.options;
            const tx = voting.connect(voter).vote(a.poll, a.option);
            if (shouldWork) {
              await tx;
              m.votes[a.option] += 1;
              m.voted.add(a.who);
            } else {
              await expect(tx).to.be.reverted;
            }
          }

          for (const id of [1, 2]) {
            const onChain = await voting.getPoll(id);
            const votes = onChain.votes.map(Number);
            expect(votes).to.deep.equal(model[id].votes);
            const sum = votes.reduce((x, y) => x + y, 0);
            expect(Number(onChain.totalVotes)).to.equal(sum);
            expect(sum).to.equal(model[id].voted.size); // one vote per address
            for (let w = 0; w < voters.length; w++) {
              expect(await voting.hasVoted(id, voters[w].address)).to.equal(model[id].voted.has(w));
            }
          }
        }),
        { numRuns: 50 }
      );
    });
  });
});
