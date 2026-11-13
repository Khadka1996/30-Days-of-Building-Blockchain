// Fuzz tests with fast-check: random holders, random votes, random attacks.
// Every run starts from the same clean chain snapshot (loadFixture).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const fc = require("fast-check");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deployDAO } = require("../scripts/deployDAO");
const { tagged, E, State, mine } = require("./helpers");

async function fuzzFixture() {
  const signers = await ethers.getSigners();
  const [deployer] = signers;
  const voters = signers.slice(1, 6); // 5 voters
  const outsider = signers[7];
  const d = await deployDAO();
  const lender = await ethers.deployContract("FlashLender", [await d.token.getAddress()]);
  await d.token.transfer(await lender.getAddress(), E(500000));
  // the proposer: exactly the threshold, never votes
  await d.token.transfer(signers[6].address, E(10000));
  await d.token.connect(signers[6]).delegate(signers[6].address);
  await deployer.sendTransaction({ to: await d.timelock.getAddress(), value: E(10) });
  return { ...d, lender, deployer, voters, proposer: signers[6], outsider };
}

const choiceArb = fc.constantFrom("none", "against", "for", "abstain");
// up to 97,000 HVT each (5 voters fit inside the deployer's remaining 490,000)
const holdingArb = fc.bigInt({ min: 0n, max: 97000n });

describe("Fuzz: random votes always give the result a simple model predicts", function () {
  this.timeout(300000);

  it("60 random elections: tallies, quorum and pass/fail match the model, late token moves change nothing", async function () {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ amount: holdingArb, choice: choiceArb, moveAfterSnapshot: fc.boolean() }), {
          minLength: 5,
          maxLength: 5,
        }),
        async (people) => {
          const f = await loadFixture(fuzzFixture);
          for (let i = 0; i < 5; i++) {
            const amount = E(people[i].amount);
            if (amount > 0n) await f.token.transfer(f.voters[i].address, amount);
            await f.token.connect(f.voters[i]).delegate(f.voters[i].address);
          }
          await mine(1);

          const targets = [f.outsider.address];
          const values = [E(1)];
          const calldatas = ["0x"];
          const description = tagged("fuzz grant", f.proposer);
          await f.dao.connect(f.proposer).propose(targets, values, calldatas, description);
          const id = await f.dao.hashProposal(targets, values, calldatas, ethers.id(description));
          await mine(f.settings.votingDelay + 1);

          const model = { against: 0n, for: 0n, abstain: 0n };
          for (let i = 0; i < 5; i++) {
            const { choice, moveAfterSnapshot } = people[i];
            const amount = E(people[i].amount);
            if (choice !== "none") {
              const support = { against: 0, for: 1, abstain: 2 }[choice];
              await f.dao.connect(f.voters[i]).castVote(id, support);
              model[choice] += amount;
            }
            // after voting starts, hand the tokens to the next voter: it must not change their weight
            if (moveAfterSnapshot && amount > 0n) {
              const next = f.voters[(i + 1) % 5];
              await f.token.connect(f.voters[i]).transfer(next.address, amount);
            }
          }

          const [against, forVotes, abstain] = await f.dao.proposalVotes(id);
          expect(against).to.equal(model.against);
          expect(forVotes).to.equal(model.for);
          expect(abstain).to.equal(model.abstain);

          await mine(f.settings.votingPeriod + 1);
          const quorum = (E(1000000) * 4n) / 100n;
          const passes = model.for > model.against && model.for + model.abstain >= quorum;
          expect(await f.dao.state(id)).to.equal(passes ? State.Succeeded : State.Defeated);
        }
      ),
      { numRuns: 60 }
    );
  });

  it("40 random flash loans: a borrower's vote weight is always 0 and the proposal threshold is never met", async function () {
    await fc.assert(
      fc.asyncProperty(fc.bigInt({ min: 1n, max: 500000n }), fc.boolean(), async (amount, tryVote) => {
        const f = await loadFixture(fuzzFixture);
        const voter = await ethers.deployContract("FlashVoter", [
          await f.token.getAddress(),
          await f.lender.getAddress(),
        ]);
        if (tryVote) {
          const targets = [f.outsider.address];
          const desc = tagged("flash target", f.proposer);
          await f.dao.connect(f.proposer).propose(targets, [0n], ["0x"], desc);
          const id = await f.dao.hashProposal(targets, [0n], ["0x"], ethers.id(desc));
          await mine(f.settings.votingDelay + 1);
          await voter.attackVote(await f.dao.getAddress(), id, E(amount));
          expect(await voter.weightUsed()).to.equal(0n);
          const [a, fo, ab] = await f.dao.proposalVotes(id);
          expect(a + fo + ab).to.equal(0n);
        } else {
          await voter.attackPropose(await f.dao.getAddress(), E(amount));
          expect(await voter.proposeSucceeded()).to.equal(false);
        }
        // the lender always gets every token back
        expect(await f.token.balanceOf(await f.lender.getAddress())).to.equal(E(500000));
      }),
      { numRuns: 40 }
    );
  });
});
