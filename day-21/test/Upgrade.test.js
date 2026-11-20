// UUPS upgrade of the Day 15 staking contract: a safe V1 → V2 upgrade keeps every balance,
// and each upgrade mistake from QA.md (F-01 … F-06) is shown failing, then fixed.
const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture, time, takeSnapshot } = require("@nomicfoundation/hardhat-network-helpers");
const { E, stakingFixture } = require("./helpers");

const DAY = 24 * 3600;

async function stakedFixture() {
  const f = await stakingFixture();
  const { proxy, ram, sita } = f;
  await proxy.notifyRewardAmount(E(70_000), 7 * DAY); // 10,000 HRW a day
  await proxy.connect(ram).stake(E(1_000));
  await proxy.connect(sita).stake(E(3_000));
  await time.increase(2 * DAY);
  return f;
}

describe("Day 21 — UUPS upgrade: V1 → V2 without moving anyone's tokens", function () {
  it("V1 behind a proxy works like Day 15 and reports version 1.0.0", async function () {
    const { proxy, ram, sita } = await loadFixture(stakedFixture);
    expect(await proxy.version()).to.equal("1.0.0");
    expect(await proxy.totalStaked()).to.equal(E(4_000));
    // 2 days × 10,000 HRW shared 1 : 3 (to within a second of rewards).
    expect(await proxy.earned(ram.address)).to.be.closeTo(E(5_000), E(1));
    expect(await proxy.earned(sita.address)).to.be.closeTo(E(15_000), E(1));
  });

  it("the safe upgrade keeps the address, every balance and every reward, then adds the pause", async function () {
    const { proxy, him, hrw, ram, sita, hari, guardian } = await loadFixture(stakedFixture);
    const address = await proxy.getAddress();
    const implV1 = await upgrades.erc1967.getImplementationAddress(address);
    const before = {
      total: await proxy.totalStaked(),
      ram: await proxy.balanceOf(ram.address),
      ramEarned: await proxy.earned(ram.address),
      rpt: await proxy.rewardPerTokenStored(),
      finish: await proxy.periodFinish(),
      him: await him.balanceOf(address),
    };

    // The plugin checks the storage layout first, then upgrades and runs initializeV2 in ONE tx.
    const V2 = await ethers.getContractFactory("HimalStakingV2");
    const v2 = await upgrades.upgradeProxy(address, V2, { call: { fn: "initializeV2", args: [guardian.address] } });

    expect(await v2.getAddress()).to.equal(address); // users keep the same address
    expect(await upgrades.erc1967.getImplementationAddress(address)).to.not.equal(implV1);
    expect(await v2.version()).to.equal("2.0.0");
    expect(await v2.totalStaked()).to.equal(before.total);
    expect(await v2.balanceOf(ram.address)).to.equal(before.ram);
    expect(await v2.rewardPerTokenStored()).to.equal(before.rpt);
    expect(await v2.periodFinish()).to.equal(before.finish);
    expect(await v2.earned(ram.address)).to.be.gte(before.ramEarned); // still growing
    expect(await him.balanceOf(address)).to.equal(before.him); // no token moved
    expect(await v2.guardian()).to.equal(guardian.address);

    // New in V2: the guardian pauses NEW stakes. Withdrawals and rewards still work.
    await v2.connect(guardian).setStakingPaused(true);
    await expect(v2.connect(hari).stake(E(10))).to.be.revertedWithCustomError(v2, "StakingIsPaused");
    await expect(v2.connect(hari).setStakingPaused(false)).to.be.revertedWithCustomError(v2, "NotGuardian");

    await time.increase(5 * DAY + 1); // the reward period ends
    const hrwRam = await hrw.balanceOf(ram.address);
    await v2.connect(ram).withdraw(E(1_000));
    await v2.connect(ram).getReward();
    await v2.connect(sita).withdraw(E(3_000));
    await v2.connect(sita).getReward();
    expect(await him.balanceOf(ram.address)).to.equal(E(1_000_000)); // every HIM back
    expect(await him.balanceOf(sita.address)).to.equal(E(1_000_000));
    // 70,000 HRW shared 1 : 3 across the upgrade (rounding dust only).
    expect((await hrw.balanceOf(ram.address)) - hrwRam).to.be.closeTo(E(17_500), E(1));
    expect(await hrw.balanceOf(sita.address)).to.be.closeTo(E(52_500), E(1));
  });

  it("F-04: the plugin refuses a V2 that inserts a variable, and forcing it in breaks the staking", async function () {
    const { proxy, owner, ram, him, hrw } = await loadFixture(stakedFixture);
    const address = await proxy.getAddress();
    const Clash = await ethers.getContractFactory("HimalStakingV2Clash");

    // The safe V2 passes the layout check; the clashing one is refused before anything is sent.
    await upgrades.validateUpgrade(address, await ethers.getContractFactory("HimalStakingV2"));
    await expect(upgrades.validateUpgrade(address, Clash)).to.be.rejectedWith(/New storage layout is incompatible/);

    // Force it in by hand (what a team without the check might do) and look at the damage.
    const impl = await Clash.deploy();
    await proxy.connect(owner).upgradeToAndCall(await impl.getAddress(), "0x");
    const broken = Clash.attach(address);
    expect(await broken.stakingToken()).to.equal(await hrw.getAddress()); // reads the reward token's slot
    expect(await broken.withdrawFeeBps()).to.equal(BigInt(await him.getAddress())); // an address read as a fee
    expect(await broken.totalStaked()).to.equal(0n); // reads the empty slot of a mapping
    expect(await broken.balanceOf(ram.address)).to.not.equal(E(1_000)); // Ram's 1,000 HIM "disappeared"
    await expect(broken.connect(ram).withdraw(E(1_000))).to.be.reverted;
  });

  it("F-01: if _authorizeUpgrade is empty, anyone can upgrade to a drainer and take every staked token", async function () {
    const { him, hrw, ram, attacker, owner } = await loadFixture(stakingFixture);
    const Open = await ethers.getContractFactory("HimalStakingV1OpenUpgrade");
    const open = await upgrades.deployProxy(Open, [await him.getAddress(), await hrw.getAddress(), owner.address], {
      kind: "uups",
    });
    await him.connect(ram).approve(await open.getAddress(), ethers.MaxUint256);
    await open.connect(ram).stake(E(1_000));

    const drainer = await ethers.deployContract("Drainer");
    const data = drainer.interface.encodeFunctionData("drain", [await him.getAddress(), attacker.address]);
    const start = await him.balanceOf(attacker.address);
    await open.connect(attacker).upgradeToAndCall(await drainer.getAddress(), data);
    expect((await him.balanceOf(attacker.address)) - start).to.equal(E(1_000)); // stolen

    // Fixed: in V1 only the owner can upgrade.
    const { proxy } = await loadFixture(stakedFixture);
    await expect(proxy.connect(attacker).upgradeToAndCall(await drainer.getAddress(), data))
      .to.be.revertedWithCustomError(proxy, "OwnableUnauthorizedAccount")
      .withArgs(attacker.address);
  });

  it("F-02: a proxy created first and initialized later can be taken over by whoever initializes first", async function () {
    const { him, hrw, attacker } = await loadFixture(stakingFixture);
    const impl = await ethers.deployContract("HimalStakingV1");
    // Step 1 of a two-step deploy: an empty proxy. Before step 2, the attacker initializes it.
    const raw = await ethers.deployContract("ERC1967Proxy", [await impl.getAddress(), "0x"]);
    const hijacked = await ethers.getContractAt("HimalStakingV1", await raw.getAddress());
    await hijacked.connect(attacker).initialize(await him.getAddress(), await hrw.getAddress(), attacker.address);
    expect(await hijacked.owner()).to.equal(attacker.address); // the attacker now controls upgrades

    // Fixed: deployProxy passes the initialize call to the proxy's constructor, so it is never open.
    const { proxy } = await loadFixture(stakingFixture);
    await expect(
      proxy.connect(attacker).initialize(await him.getAddress(), await hrw.getAddress(), attacker.address),
    ).to.be.revertedWithCustomError(proxy, "InvalidInitialization");
  });

  it("F-03: the logic contract itself is locked: nobody can initialize or upgrade it directly", async function () {
    const { proxy, him, hrw, attacker } = await loadFixture(stakingFixture);
    const impl = await ethers.getContractAt(
      "HimalStakingV1",
      await upgrades.erc1967.getImplementationAddress(await proxy.getAddress()),
    );
    await expect(
      impl.connect(attacker).initialize(await him.getAddress(), await hrw.getAddress(), attacker.address),
    ).to.be.revertedWithCustomError(impl, "InvalidInitialization");
    await expect(impl.connect(attacker).upgradeToAndCall(attacker.address, "0x")).to.be.revertedWithCustomError(
      impl,
      "UUPSUnauthorizedCallContext",
    );
  });

  it("F-05: upgrading to a contract that is not UUPS is refused, so the proxy cannot be bricked", async function () {
    const { proxy, owner, him } = await loadFixture(stakedFixture);
    // HIM is a plain ERC-20 with no upgrade function: after such an upgrade, no one could ever upgrade again.
    await expect(proxy.connect(owner).upgradeToAndCall(await him.getAddress(), "0x")).to.be.revertedWithCustomError(
      proxy,
      "ERC1967InvalidImplementation",
    );
    await expect(proxy.connect(owner).upgradeToAndCall(owner.address, "0x")).to.be.reverted; // not even a contract
    expect(await proxy.version()).to.equal("1.0.0");
  });

  it("F-06: the V2 setup must be owner-only and sent with the upgrade, or anyone picks the guardian", async function () {
    const { proxy, owner, attacker, guardian } = await loadFixture(stakedFixture);
    const address = await proxy.getAddress();

    // Naive: upgrade in one tx, setup in a second tx. The attacker sends the setup first.
    const openImpl = await ethers.deployContract("HimalStakingV2OpenInit");
    await proxy.connect(owner).upgradeToAndCall(await openImpl.getAddress(), "0x");
    const open = await ethers.getContractAt("HimalStakingV2OpenInit", address);
    await open.connect(attacker).initializeV2(attacker.address);
    expect(await open.guardian()).to.equal(attacker.address);
    await expect(open.connect(owner).initializeV2(guardian.address)).to.be.revertedWithCustomError(
      open,
      "InvalidInitialization",
    ); // and the owner can no longer fix it

    // Fixed: initializeV2 is onlyOwner, and runs inside upgradeToAndCall (one transaction).
    const f = await loadFixture(stakedFixture);
    const v2Impl = await ethers.deployContract("HimalStakingV2");
    // Even if the owner sent the upgrade without the setup, a stranger still cannot run it.
    const snap = await takeSnapshot();
    await f.proxy.connect(f.owner).upgradeToAndCall(await v2Impl.getAddress(), "0x");
    const bare = await ethers.getContractAt("HimalStakingV2", await f.proxy.getAddress());
    await expect(bare.connect(f.attacker).initializeV2(f.attacker.address))
      .to.be.revertedWithCustomError(bare, "OwnableUnauthorizedAccount")
      .withArgs(f.attacker.address);
    await snap.restore();
    const data = v2Impl.interface.encodeFunctionData("initializeV2", [guardian.address]);
    await expect(f.proxy.connect(f.attacker).upgradeToAndCall(await v2Impl.getAddress(), data)).to.be.reverted;
    await f.proxy.connect(f.owner).upgradeToAndCall(await v2Impl.getAddress(), data);
    const v2 = await ethers.getContractAt("HimalStakingV2", await f.proxy.getAddress());
    expect(await v2.guardian()).to.equal(guardian.address);
    await expect(v2.connect(f.owner).initializeV2(f.attacker.address)).to.be.revertedWithCustomError(
      v2,
      "InvalidInitialization",
    ); // runs only once
    // The V2 logic contract is locked too.
    await expect(v2Impl.initializeV2(attacker.address)).to.be.reverted;
  });
});
