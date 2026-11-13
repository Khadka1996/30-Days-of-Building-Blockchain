const { ethers } = require("hardhat");
const { mine, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployDAO } = require("../scripts/deployDAO");

const E = (n) => ethers.parseEther(String(n));
const State = { Pending: 0n, Active: 1n, Canceled: 2n, Defeated: 3n, Succeeded: 4n, Queued: 5n, Expired: 6n, Executed: 7n };
const Vote = { Against: 0, For: 1, Abstain: 2 };

// Deploy the DAO, hand out tokens, let holders delegate to themselves,
// fund the treasury with 20 ETH and give a flash-loan pool 60% of the supply.
async function baseFixture() {
  const [deployer, ram, sita, hari, gita, attacker, school, friend] = await ethers.getSigners();
  const d = await deployDAO();
  const { token, timelock } = d;

  const lender = await ethers.deployContract("FlashLender", [await token.getAddress()]);
  await token.transfer(ram.address, E(200000));
  await token.transfer(sita.address, E(120000));
  await token.transfer(hari.address, E(75000));
  await token.transfer(gita.address, E(5000));
  await token.transfer(await lender.getAddress(), E(600000));

  for (const s of [ram, sita, hari, gita]) await token.connect(s).delegate(s.address);
  await deployer.sendTransaction({ to: await timelock.getAddress(), value: E(20) });
  await mine(1); // so the delegations are in the past

  return { ...d, lender, deployer, ram, sita, hari, gita, attacker, school, friend };
}

// A grant proposal: pay `amount` ETH to `recipient` and list the project on the fund board.
// Every description ends with "#proposer=<address>" (required by HimalDAO, see QA.md F-06).
const tagged = (text, signer) => `${text}#proposer=${signer.address.toLowerCase()}`;

async function grantProposal(f, recipient, proposer, amount = E(5), text = "Grant: 5 ETH for the Bhaktapur school library") {
  const description = tagged(text, proposer);
  const targets = [recipient, await f.fund.getAddress()];
  const values = [amount, 0n];
  const calldatas = ["0x", f.fund.interface.encodeFunctionData("approveProject", ["School library", recipient, amount])];
  const descriptionHash = ethers.id(description);
  const id = await f.dao.hashProposal(targets, values, calldatas, descriptionHash);
  return { targets, values, calldatas, description, descriptionHash, id };
}

async function propose(f, signer, p) {
  await (await f.dao.connect(signer).propose(p.targets, p.values, p.calldatas, p.description)).wait();
  return p.id;
}

async function toVoting(f) {
  await mine(f.settings.votingDelay + 1);
}
async function endVoting(f) {
  await mine(f.settings.votingPeriod + 1);
}

module.exports = { tagged, E, State, Vote, baseFixture, grantProposal, propose, toVoting, endVoting, mine, time };
