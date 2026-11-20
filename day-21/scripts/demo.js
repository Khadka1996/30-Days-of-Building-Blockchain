// Day 21 demo: upgrade the Day 15 staking contract from V1 to V2 behind a UUPS proxy,
// then show four upgrade mistakes and what they would cost.
// Run: npm run demo
const { ethers, upgrades } = require("hardhat");
const { time, takeSnapshot } = require("@nomicfoundation/hardhat-network-helpers");
const { E, stakingFixture } = require("../test/helpers");

const DAY = 24 * 3600;
const fmt = (x, d = 2) => Number(ethers.formatEther(x)).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const line = (label, value) => console.log(`${label.padEnd(54)}${value}`);
const gas = async (txOrPromise) => (await (await txOrPromise).wait()).gasUsed.toString();

async function main() {
  const f = await stakingFixture();
  const { proxy, him, hrw, owner, ram, sita, hari, attacker, guardian } = f;
  const address = await proxy.getAddress();
  const implOf = async () => short(await upgrades.erc1967.getImplementationAddress(address));

  console.log("\n=== HimalStaking V1 behind a UUPS proxy ===");
  line("proxy address (what users use, never changes)", short(address));
  line("logic contract V1", await implOf());
  line("version()", await proxy.version());
  await proxy.notifyRewardAmount(E(70_000), 7 * DAY);
  line("Ram stakes 1,000 HIM", `gas used: ${await gas(proxy.connect(ram).stake(E(1_000)))}`);
  await proxy.connect(sita).stake(E(3_000));
  line("Sita stakes 3,000 HIM", `total staked ${fmt(await proxy.totalStaked())} HIM`);
  await time.increase(2 * DAY);
  line("after 2 days, Ram has earned", `${fmt(await proxy.earned(ram.address))} HRW`);
  line("               Sita has earned", `${fmt(await proxy.earned(sita.address))} HRW`);

  const beforeAttacks = await takeSnapshot();

  console.log("\n=== Safe upgrade to V2 (adds an emergency pause for new stakes) ===");
  const V2 = await ethers.getContractFactory("HimalStakingV2");
  await upgrades.validateUpgrade(address, V2);
  line("storage layout check (OpenZeppelin plugin)", "passed: 2 new variables appended");
  const v2Impl = await V2.deploy();
  const data = V2.interface.encodeFunctionData("initializeV2", [guardian.address]);
  line("upgradeToAndCall(V2, initializeV2) in ONE tx", `gas used: ${await gas(proxy.connect(owner).upgradeToAndCall(await v2Impl.getAddress(), data))}`);
  const v2 = V2.attach(address);
  line("proxy address", `${short(address)} (same)`);
  line("logic contract now", await implOf());
  line("version()", await v2.version());
  line("total staked after the upgrade", `${fmt(await v2.totalStaked())} HIM (unchanged)`);
  line("HIM held by the proxy", `${fmt(await him.balanceOf(address))} HIM (no token moved)`);
  line("Ram's rewards keep growing", `${fmt(await v2.earned(ram.address))} HRW`);
  await v2.connect(guardian).setStakingPaused(true);
  const paused = await v2.connect(hari).stake(E(10)).then(() => "accepted", (e) => `refused (${e.message.match(/custom error '(\w+)/)?.[1] ?? "reverted"})`);
  line("guardian pauses new stakes; Hari tries to stake", paused);
  await time.increase(5 * DAY + 1);
  await v2.connect(ram).withdraw(E(1_000));
  await v2.connect(ram).getReward();
  line("reward period ends; Ram withdraws during the pause", `${fmt(await him.balanceOf(ram.address) - E(999_000))} HIM back`);
  line("Ram's HRW for the week (about 1/4 of 70,000)", `${fmt(await hrw.balanceOf(ram.address))} HRW`);

  console.log("\n=== Mistake 1: a V2 that INSERTS a variable (storage clash) ===");
  await beforeAttacks.restore();
  const Clash = await ethers.getContractFactory("HimalStakingV2Clash");
  const refused = await upgrades.validateUpgrade(address, Clash).then(() => "passed?!", () => "refused: inserted `withdrawFeeBps`");
  line("storage layout check", refused);
  const clashImpl = await Clash.deploy();
  await proxy.connect(owner).upgradeToAndCall(await clashImpl.getAddress(), "0x");
  const broken = Clash.attach(address);
  line("forced in anyway: stakingToken() is now", (await broken.stakingToken()) === (await hrw.getAddress()) ? "HRW (the reward token!)" : "?");
  line("  totalStaked()", `${fmt(await broken.totalStaked())} HIM (was 4,000.00)`);
  line("  withdrawFeeBps() reads the old HIM address as", `${(await broken.withdrawFeeBps()).toString().slice(0, 12)}… basis points`);
  const w = await broken.connect(ram).withdraw(E(1_000)).then(() => "worked", () => "REVERTS: 4,000 HIM stuck");
  line("  Ram tries to withdraw his 1,000 HIM", w);

  console.log("\n=== Mistake 2: _authorizeUpgrade left empty (anyone can upgrade) ===");
  await beforeAttacks.restore();
  const Open = await ethers.getContractFactory("HimalStakingV1OpenUpgrade");
  const open = await upgrades.deployProxy(Open, [await him.getAddress(), await hrw.getAddress(), owner.address], { kind: "uups" });
  for (const p of [ram, sita]) await him.connect(p).approve(await open.getAddress(), ethers.MaxUint256);
  await open.connect(ram).stake(E(1_000));
  await open.connect(sita).stake(E(3_000));
  const drainer = await ethers.deployContract("Drainer");
  const steal = drainer.interface.encodeFunctionData("drain", [await him.getAddress(), attacker.address]);
  const a0 = await him.balanceOf(attacker.address);
  await open.connect(attacker).upgradeToAndCall(await drainer.getAddress(), steal);
  line("attacker upgrades to a 'drainer' and takes", `${fmt((await him.balanceOf(attacker.address)) - a0)} HIM`);
  const fixed1 = await proxy.connect(attacker).upgradeToAndCall(await drainer.getAddress(), steal).then(() => "worked?!", () => "refused (OwnableUnauthorizedAccount)");
  line("same attack on HimalStakingV1 (onlyOwner)", fixed1);

  console.log("\n=== Mistake 3: create the proxy, initialize it in a second transaction ===");
  const impl = await ethers.deployContract("HimalStakingV1");
  const raw = await ethers.deployContract("ERC1967Proxy", [await impl.getAddress(), "0x"]);
  const hijack = await ethers.getContractAt("HimalStakingV1", await raw.getAddress());
  await hijack.connect(attacker).initialize(await him.getAddress(), await hrw.getAddress(), attacker.address);
  line("attacker initializes first; owner() is now", (await hijack.owner()) === attacker.address ? "the attacker" : "?");
  const fixed2 = await proxy.connect(attacker).initialize(await him.getAddress(), await hrw.getAddress(), attacker.address).then(() => "worked?!", () => "refused (InvalidInitialization)");
  line("with deployProxy (initialize inside the constructor)", fixed2);

  console.log("\n=== Mistake 4: upgrade to a contract that is not UUPS ===");
  const fixed3 = await proxy.connect(owner).upgradeToAndCall(await him.getAddress(), "0x").then(() => "accepted: proxy bricked", () => "refused (ERC1967InvalidImplementation)");
  line("owner points the proxy at the HIM token by mistake", fixed3);
  line("version() afterwards", await proxy.version());
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
