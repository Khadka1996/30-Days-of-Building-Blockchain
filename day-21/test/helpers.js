const { ethers, upgrades } = require("hardhat");

const E = (n) => ethers.parseEther(String(n));
const RUNS = Number(process.env.FUZZ_RUNS || 25); // random runs per invariant suite
const STEPS = Number(process.env.FUZZ_STEPS || 30); // max actions per run

/** Send a transaction; return true if it succeeded, false if it reverted. */
async function ok(p) {
  try {
    await (await p).wait();
    return true;
  } catch {
    return false;
  }
}

const token = (name, symbol, holder) => ethers.deployContract("HimalToken", [name, symbol, E(1_000_000_000), holder]);

/** Give each person `amount` of each token and approve each spender for everything. */
async function fundAndApprove(tokens, people, spenders, amount = E(1_000_000)) {
  for (const t of tokens) {
    for (const p of people) {
      await t.transfer(p.address, amount);
      for (const s of spenders) await t.connect(p).approve(s, ethers.MaxUint256);
    }
  }
}

/** Day 15 world, deployed two ways: the original contract and the V1 contract behind a UUPS proxy. */
async function stakingFixture() {
  const [owner, ram, sita, hari, attacker, guardian] = await ethers.getSigners();
  const him = await token("Himal Token", "HIM", owner.address);
  const hrw = await token("Himal Reward", "HRW", owner.address);
  const plain = await ethers.deployContract("HimalStaking", [await him.getAddress(), await hrw.getAddress(), owner.address]);
  const V1 = await ethers.getContractFactory("HimalStakingV1");
  // deployProxy creates the ERC1967Proxy AND calls initialize in the same transaction (F-02).
  const proxy = await upgrades.deployProxy(V1, [await him.getAddress(), await hrw.getAddress(), owner.address], {
    kind: "uups",
  });
  const spenders = [await plain.getAddress(), await proxy.getAddress()];
  await fundAndApprove([him], [ram, sita, hari, attacker], spenders);
  for (const s of spenders) await hrw.approve(s, ethers.MaxUint256);
  return { owner, ram, sita, hari, attacker, guardian, him, hrw, plain, proxy };
}

module.exports = { E, RUNS, STEPS, ok, token, fundAndApprove, stakingFixture };
