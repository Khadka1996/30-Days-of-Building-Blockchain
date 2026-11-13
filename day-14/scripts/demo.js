// Day 14 demo: one grant proposal from start to finish, then the attacks.
// Run: npx hardhat run scripts/demo.js
const { ethers } = require("hardhat");
const { mine, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployDAO } = require("./deployDAO");

const E = (n) => ethers.parseEther(String(n));
const fmt = (wei) => Number(ethers.formatEther(wei)).toLocaleString("en-US");
const STATES = ["Pending", "Active", "Canceled", "Defeated", "Succeeded", "Queued", "Expired", "Executed"];
const row = (label, value) => console.log(label.padEnd(46) + value);
const tagged = (text, signer) => `${text}#proposer=${signer.address.toLowerCase()}`;
async function reason(promise, iface) {
  try {
    await promise;
    return "succeeded (unexpected!)";
  } catch (e) {
    const data = e.data || e.error?.data;
    if (data && iface) {
      try {
        return "reverted with " + iface.parseError(data).name;
      } catch (_) {}
    }
    const m = /custom error '([A-Za-z]+)/.exec(e.message) || /reverted with reason string '([^']+)'/.exec(e.message);
    return "reverted with " + (m ? m[1] : e.shortMessage || e.message);
  }
}

async function main() {
  const [deployer, ram, sita, hari, gita, attacker, school] = await ethers.getSigners();
  const { token, timelock, dao, fund, settings } = await deployDAO();
  const lender = await ethers.deployContract("FlashLender", [await token.getAddress()]);

  await token.transfer(ram.address, E(200000));
  await token.transfer(sita.address, E(120000));
  await token.transfer(hari.address, E(75000));
  await token.transfer(gita.address, E(5000));
  await token.transfer(await lender.getAddress(), E(600000));
  await deployer.sendTransaction({ to: await timelock.getAddress(), value: E(20) });

  console.log("=== Himal DAO: 1,000,000 HVT, treasury 20 ETH ===");
  row("Voting delay / voting period", `${settings.votingDelay} blocks (~1 day) / ${settings.votingPeriod} blocks (~1 week)`);
  row("Proposal threshold / quorum", `${fmt(await dao.proposalThreshold())} HVT (1%) / 4% of supply`);
  row("Timelock delay", `${(await timelock.getMinDelay()) / 3600n} hours`);
  row("Deployer still admin of the treasury?", String(await timelock.hasRole(await timelock.DEFAULT_ADMIN_ROLE(), deployer.address)));
  row("Ram's votes before delegating", `${fmt(await token.getVotes(ram.address))} HVT`);
  const tx = await token.connect(ram).delegate(ram.address);
  row("Ram delegates to himself", `${fmt(await token.getVotes(ram.address))} votes, gas used: ${(await tx.wait()).gasUsed}`);
  for (const s of [sita, hari, gita]) await token.connect(s).delegate(s.address);
  await mine(1);

  // --- the proposal ---
  const text = "Grant: 5 ETH for the Bhaktapur school library";
  const targets = [school.address, await fund.getAddress()];
  const values = [E(5), 0n];
  const calldatas = ["0x", fund.interface.encodeFunctionData("approveProject", ["School library", school.address, E(5)])];
  const description = tagged(text, ram);
  const descHash = ethers.id(description);
  const id = await dao.hashProposal(targets, values, calldatas, descHash);

  console.log("\n=== Proposal: " + text + " ===");
  row("Gita (5,000 HVT) tries to propose it", await reason(dao.connect(gita).propose(targets, values, calldatas, tagged(text, gita)), dao.interface));
  row("Hari copies Ram's proposal (Ram's tag)", await reason(dao.connect(hari).propose(targets, values, calldatas, description), dao.interface));
  const ptx = await dao.connect(ram).propose(targets, values, calldatas, description);
  row("Ram proposes", `${STATES[await dao.state(id)]}, gas used: ${(await ptx.wait()).gasUsed}`);
  row("Sita votes before the delay is over", await reason(dao.connect(sita).castVote(id, 1), dao.interface));
  await mine(settings.votingDelay + 1);
  row("After 7,200 blocks", STATES[await dao.state(id)]);
  const vtx = await dao.connect(ram).castVote(id, 1);
  row("Ram votes For", `200,000 HVT, gas used: ${(await vtx.wait()).gasUsed}`);
  await dao.connect(sita).castVoteWithReason(id, 0, "Too much for one school");
  row("Sita votes Against", "120,000 HVT");
  await dao.connect(hari).castVote(id, 1);
  row("Hari votes For", "75,000 HVT");

  // --- flash-loan attack on the real DAO, while voting is open ---
  const voter = await ethers.getContractFactory("FlashVoter", attacker).then((f) => f.deploy(token.getAddress(), lender.getAddress()));
  await voter.attackVote(await dao.getAddress(), id, E(600000));
  row("Attacker flash-borrows 600,000 HVT and votes", `vote weight counted: ${fmt(await voter.weightUsed())}`);
  await voter.attackPropose(await dao.getAddress(), E(600000));
  row("Attacker flash-borrows to make a proposal", "reverted with " + dao.interface.parseError(await voter.proposeError()).name);

  const [against, forVotes, abstain] = await dao.proposalVotes(id);
  row("Tally (For / Against / Abstain)", `${fmt(forVotes)} / ${fmt(against)} / ${fmt(abstain)}`);
  await mine(settings.votingPeriod + 1);
  row("After the voting week", STATES[await dao.state(id)]);
  await dao.queue(targets, values, calldatas, descHash);
  row("Queued in the timelock", STATES[await dao.state(id)]);
  row("Execute straight away", await reason(dao.execute(targets, values, calldatas, descHash), timelock.interface));
  await time.increase(2 * 24 * 3600 + 1);
  const before = await ethers.provider.getBalance(school.address);
  const etx = await dao.connect(attacker).execute(targets, values, calldatas, descHash);
  const gas = (await etx.wait()).gasUsed;
  row("2 days later, anyone executes", `${STATES[await dao.state(id)]}, gas used: ${gas}`);
  row("School received", `${fmt((await ethers.provider.getBalance(school.address)) - before)} ETH`);
  row("Projects on the community fund board", String(await fund.projectCount()));
  row("Treasury left", `${fmt(await ethers.provider.getBalance(await timelock.getAddress()))} ETH`);

  // --- the naive DAO ---
  console.log("\n=== The naive DAO (votes = balance right now, no delay), treasury 10 ETH ===");
  const naive = await ethers.deployContract("NaiveDAO", [await token.getAddress()]);
  await deployer.sendTransaction({ to: await naive.getAddress(), value: E(10) });
  const voter2 = await ethers.getContractFactory("FlashVoter", attacker).then((f) => f.deploy(token.getAddress(), lender.getAddress()));
  const a0 = await ethers.provider.getBalance(attacker.address);
  const ntx = await voter2.connect(attacker).attackNaive(await naive.getAddress(), E(600000));
  const r = await ntx.wait();
  const gained = (await ethers.provider.getBalance(attacker.address)) - a0 + r.gasUsed * r.gasPrice;
  row("Borrow, propose, vote, execute, repay", `one transaction, gas used: ${r.gasUsed}`);
  row("Attacker gained", `${fmt(gained)} ETH`);
  row("Naive DAO treasury left", `${fmt(await ethers.provider.getBalance(await naive.getAddress()))} ETH`);
  row("Tokens the attacker owns afterwards", fmt(await token.balanceOf(attacker.address)));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
