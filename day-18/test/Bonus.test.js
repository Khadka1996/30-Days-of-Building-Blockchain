const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, mine } = require("@nomicfoundation/hardhat-network-helpers");
const { E, MAX, fee, baseFixture } = require("./helpers");

// The attacker borrows 100,000 HIM for one transaction to look like a big holder.
const LOAN = E(100_000);

async function attackFixture() {
  const f = await baseFixture();
  const atk = await ethers.deployContract("BonusAttacker", [f.L, f.A.him, f.A.husd], f.attacker);
  await f.him.connect(f.attacker).approve(await atk.getAddress(), MAX);
  return { ...f, atk };
}

describe("Using a flash loan to attack another contract (F-01)", function () {
  it("NaiveBonus pays on the balance RIGHT NOW: a 100,000 HIM flash loan empties the 10,000 HUSD pot", async function () {
    const f = await loadFixture(attackFixture);
    const N = await f.naive.getAddress();
    await f.atk.connect(f.attacker).attack(N, LOAN, fee(LOAN));
    expect(await f.husd.balanceOf(f.attacker.address)).to.equal(E(10_000)); // the whole pot
    expect(await f.him.balanceOf(f.attacker.address)).to.equal(E(1_000) - fee(LOAN)); // cost: 90 HIM fee
    expect(await f.husd.balanceOf(N)).to.equal(0n);
    // Ram, a real holder of 1,000 HIM, now gets nothing.
    await expect(f.naive.connect(f.ram).claim()).to.be.revertedWithCustomError(f.naive, "NothingToClaim");
  });

  it("SafeBonus reads a PAST block: the same attack reverts and the pot is untouched", async function () {
    const f = await loadFixture(attackFixture);
    const S = await f.safe.getAddress();
    await expect(f.atk.connect(f.attacker).attack(S, LOAN, fee(LOAN)))
      .to.be.revertedWithCustomError(f.safe, "NothingToClaim");
    expect(await f.husd.balanceOf(S)).to.equal(E(10_000));
    expect(await f.him.balanceOf(f.attacker.address)).to.equal(E(1_000)); // not even the fee was spent
  });

  it("real holders claim exactly what they held at the snapshot, once", async function () {
    const f = await loadFixture(attackFixture);
    await expect(f.safe.connect(f.ram).claim()).to.changeTokenBalance(f.husd, f.ram, E(100));
    await expect(f.safe.connect(f.sita).claim()).to.changeTokenBalance(f.husd, f.sita, E(500));
    await expect(f.safe.connect(f.ram).claim()).to.be.revertedWithCustomError(f.safe, "AlreadyClaimed");
  });

  it("buying or receiving HIM after the snapshot does not count", async function () {
    const f = await loadFixture(attackFixture);
    await f.him.transfer(f.ram.address, E(50_000)); // Ram gets much richer later
    await expect(f.safe.connect(f.ram).claim()).to.changeTokenBalance(f.husd, f.ram, E(100));
    await f.him.connect(f.attacker).delegate(f.attacker.address);
    await expect(f.safe.connect(f.attacker).claim()).to.be.revertedWithCustomError(f.safe, "NothingToClaim");
  });

  it("a flash loan never shows up in history, even in the block it was taken", async function () {
    const f = await loadFixture(attackFixture);
    // Attack the naive pot (it succeeds), then look at the attacker contract's recorded votes for that block.
    const tx = await f.atk.connect(f.attacker).attack(await f.naive.getAddress(), LOAN, fee(LOAN));
    const { blockNumber } = await tx.wait();
    await mine(1);
    expect(await f.him.getPastVotes(await f.atk.getAddress(), blockNumber)).to.equal(0n);
  });

  it("the snapshot must already be in the past when the bonus is created", async function () {
    const f = await loadFixture(attackFixture);
    const next = (await ethers.provider.getBlockNumber()) + 1;
    const F = await ethers.getContractFactory("SafeBonus");
    await expect(F.deploy(f.A.him, f.A.husd, next)).to.be.revertedWithCustomError(F, "SnapshotNotInPast");
  });

  it("the pot pays at most what it holds, and the NaiveBonus pays real holders fine when nobody attacks", async function () {
    const f = await loadFixture(attackFixture);
    await expect(f.naive.connect(f.sita).claim()).to.changeTokenBalance(f.husd, f.sita, E(500));
    await f.him.transfer(f.ram.address, E(200_000));
    await expect(f.safe.connect(f.ram).claim()).to.changeTokenBalance(f.husd, f.ram, E(100));
    await expect(f.naive.connect(f.ram).claim()).to.changeTokenBalance(f.husd, f.ram, E(9_500)); // capped
  });

  it("only the attacker can use their attack contract, and it only trusts the lender", async function () {
    const f = await loadFixture(attackFixture);
    await expect(f.atk.connect(f.ram).attack(await f.naive.getAddress(), LOAN, 0))
      .to.be.revertedWithCustomError(f.atk, "NotAttacker");
    await expect(f.atk.onFlashLoan(f.ram.address, f.A.him, 1, 0, "0x")).to.be.revertedWithCustomError(f.atk, "UntrustedLender");
  });
});
