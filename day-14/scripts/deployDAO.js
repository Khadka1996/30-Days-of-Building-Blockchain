// Shared deploy routine used by the tests and the demo.
// Order matters: the timelock must exist before the DAO, and the deployer's
// admin powers must be given up at the very end (see QA.md F-03).
const { ethers } = require("hardhat");

const SETTINGS = {
  votingDelay: 7200, // blocks ≈ 1 day at 12 s per block
  votingPeriod: 50400, // blocks ≈ 1 week
  proposalThreshold: ethers.parseEther("10000"), // 1% of supply
  quorumPercent: 4, // 4% of supply must vote For or Abstain
  timelockDelay: 2 * 24 * 60 * 60, // 2 days, in seconds
};

async function deployDAO(settings = SETTINGS) {
  const [deployer] = await ethers.getSigners();

  // 1. Timelock (the treasury). Executors = [address(0)] means anyone may
  //    execute a proposal once its delay is over. Deployer is temporary admin.
  const timelock = await ethers.deployContract("HimalTimelock", [
    settings.timelockDelay,
    [],
    [ethers.ZeroAddress],
    deployer.address,
  ]);

  // 2. Token: the full supply starts with the deployer, who hands it out.
  const token = await ethers.deployContract("HimalVoteToken", [deployer.address]);

  // 3. The DAO (Governor).
  const dao = await ethers.deployContract("HimalDAO", [
    await token.getAddress(),
    await timelock.getAddress(),
    settings.votingDelay,
    settings.votingPeriod,
    settings.proposalThreshold,
    settings.quorumPercent,
  ]);

  // 4. Only the DAO may queue (propose to the timelock) and cancel.
  const PROPOSER = await timelock.PROPOSER_ROLE();
  const CANCELLER = await timelock.CANCELLER_ROLE();
  const ADMIN = await timelock.DEFAULT_ADMIN_ROLE();
  await (await timelock.grantRole(PROPOSER, await dao.getAddress())).wait();
  await (await timelock.grantRole(CANCELLER, await dao.getAddress())).wait();

  // 5. Give up the deployer's admin role. From now on only a passed proposal
  //    (run by the timelock itself) can change any role.
  await (await timelock.renounceRole(ADMIN, deployer.address)).wait();

  // 6. Something the DAO controls.
  const fund = await ethers.deployContract("CommunityFund", [await timelock.getAddress()]);

  return { token, timelock, dao, fund, settings };
}

module.exports = { deployDAO, SETTINGS };
