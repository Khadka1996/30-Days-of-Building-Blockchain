// Quick demo on the local Hardhat network: create a poll, let 5 people vote,
// show that double voting and late voting fail, then read the winner.
// Prints gas per action.
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 24 * 60 * 60;
const OUTCOME = ["NoVotes", "Winner", "Tie"];

async function main() {
  const [alice, bob, carol, dave, erin, frank] = await ethers.getSigners();
  const voting = await ethers.deployContract("Voting");
  await voting.waitForDeployment();
  console.log("Voting deployed at", await voting.getAddress());

  const gas = async (label, txPromise) => {
    const receipt = await (await txPromise).wait();
    console.log(`${label.padEnd(36)} gas used: ${receipt.gasUsed}`);
  };
  const reason = async (fn) => {
    try {
      await fn();
      return "accepted (unexpected!)";
    } catch (err) {
      const data = err.data || err.error?.data;
      return data ? `reverted with ${voting.interface.parseError(data).name}` : err.message;
    }
  };

  const options = ["Buff", "Chicken", "Veg"];
  const deadline = (await time.latest()) + 3 * DAY;
  await gas("createPoll (3 options, 3 days)", voting.createPoll("Best momo filling?", options, deadline));

  const votes = [[bob, 1], [carol, 1], [dave, 0], [erin, 2], [alice, 1]];
  await gas("first vote", voting.connect(votes[0][0]).vote(1, votes[0][1]));
  for (const [who, option] of votes.slice(1)) await voting.connect(who).vote(1, option);
  console.log("5 votes cast");

  console.log("Bob votes again:".padEnd(36), await reason(() => voting.connect(bob).vote.staticCall(1, 0)));
  console.log("Result before deadline:".padEnd(36), await reason(() => voting.getResult(1)));

  await time.increaseTo(deadline);
  console.log("...3 days later...");
  console.log("Frank votes late:".padEnd(36), await reason(() => voting.connect(frank).vote.staticCall(1, 0)));

  const p = await voting.getPoll(1);
  options.forEach((o, i) => console.log(`  ${o.padEnd(8)} ${p.votes[i]} vote(s)`));
  const [outcome, winner, top] = await voting.getResult(1);
  console.log(`Result: ${OUTCOME[Number(outcome)]} — ${options[Number(winner)]} with ${top} of ${p.totalVotes} votes`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
