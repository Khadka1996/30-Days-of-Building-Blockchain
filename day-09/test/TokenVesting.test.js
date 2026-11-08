const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const fc = require("fast-check");

const HIM = (n) => ethers.parseEther(String(n));
const DAY = 24 * 60 * 60;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;
const TOTAL = HIM(12000);
const FUNDED = HIM(100000);

async function deploy() {
  const [owner, ram, sita, eve] = await ethers.getSigners();
  const token = await ethers.deployContract("HimalToken");
  const vesting = await ethers.deployContract("TokenVesting", [await token.getAddress()]);
  await token.transfer(await vesting.getAddress(), FUNDED);
  return { owner, ram, sita, eve, token, vesting, addr: await vesting.getAddress() };
}

// Ram: 12,000 HIM over 12 x 30 days, 3-month cliff, revocable. Starts 100 s from now.
async function withSchedule() {
  const f = await deploy();
  const start = (await time.latest()) + 100;
  await f.vesting.createSchedule(f.ram.address, TOTAL, start, 3 * MONTH, 12 * MONTH, true);
  return { ...f, start };
}

async function releaseAt(vesting, who, t) {
  await time.setNextBlockTimestamp(t);
  return vesting.connect(who).release();
}

describe("TokenVesting: setup", function () {
  it("rejects a zero token", async function () {
    const F = await ethers.getContractFactory("TokenVesting");
    await expect(F.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(F, "ZeroAddress");
  });

  it("creates a schedule, emits the event and counts what is owed", async function () {
    const { vesting, ram } = await loadFixture(deploy);
    const start = (await time.latest()) + 100;
    await expect(vesting.createSchedule(ram.address, TOTAL, start, 3 * MONTH, 12 * MONTH, true))
      .to.emit(vesting, "ScheduleCreated")
      .withArgs(ram.address, TOTAL, start, start + 3 * MONTH, start + 12 * MONTH, true);
    expect(await vesting.totalOwed()).to.equal(TOTAL);
    expect(await vesting.spareTokens()).to.equal(FUNDED - TOTAL);
  });

  it("only the owner can create, revoke or withdraw", async function () {
    const { vesting, ram, eve } = await loadFixture(withSchedule);
    const err = "OwnableUnauthorizedAccount";
    await expect(vesting.connect(eve).createSchedule(eve.address, 1, (await time.latest()) + 10, 0, 100, false))
      .to.be.revertedWithCustomError(vesting, err);
    await expect(vesting.connect(eve).revoke(ram.address)).to.be.revertedWithCustomError(vesting, err);
    await expect(vesting.connect(eve).withdrawSpare(eve.address, 1)).to.be.revertedWithCustomError(vesting, err);
  });

  it("rejects bad beneficiaries and amounts", async function () {
    const { vesting, ram, addr } = await loadFixture(deploy);
    const s = (await time.latest()) + 100;
    await expect(vesting.createSchedule(ethers.ZeroAddress, 1, s, 0, 100, false)).to.be.revertedWithCustomError(vesting, "BadBeneficiary");
    await expect(vesting.createSchedule(addr, 1, s, 0, 100, false)).to.be.revertedWithCustomError(vesting, "BadBeneficiary");
    await expect(vesting.createSchedule(ram.address, 0, s, 0, 100, false)).to.be.revertedWithCustomError(vesting, "BadAmount");
    await expect(vesting.createSchedule(ram.address, 2n ** 128n, s, 0, 100, false)).to.be.revertedWithCustomError(vesting, "BadAmount");
  });

  it("rejects bad times: past start, far start (ms typo), zero or huge duration, cliff after end", async function () {
    const { vesting, ram } = await loadFixture(deploy);
    const now = await time.latest();
    const go = (start, cliff, dur) => vesting.createSchedule(ram.address, 1, start, cliff, dur, false);
    await expect(go(now - 100, 0, 100)).to.be.revertedWithCustomError(vesting, "BadTimes");
    await expect(go(now * 1000, 0, 100)).to.be.revertedWithCustomError(vesting, "BadTimes");
    await expect(go(now + 100, 0, 0)).to.be.revertedWithCustomError(vesting, "BadTimes");
    await expect(go(now + 100, 0, 10 * YEAR + 1)).to.be.revertedWithCustomError(vesting, "BadTimes");
    await expect(go(now + 100, 101, 100)).to.be.revertedWithCustomError(vesting, "BadTimes");
  });

  it("allows a cliff equal to the whole duration (all at the end)", async function () {
    const { vesting, ram } = await loadFixture(deploy);
    const s = (await time.latest()) + 100;
    await vesting.createSchedule(ram.address, 1000, s, 100, 100, false);
    expect(await vesting.vestedAt(ram.address, s + 99)).to.equal(0n);
    expect(await vesting.vestedAt(ram.address, s + 100)).to.equal(1000n);
  });

  it("cannot promise more tokens than it holds", async function () {
    const { vesting, ram, sita } = await loadFixture(deploy);
    const s = (await time.latest()) + 100;
    await vesting.createSchedule(ram.address, FUNDED, s, 0, YEAR, false);
    await expect(vesting.createSchedule(sita.address, 1, s, 0, YEAR, false))
      .to.be.revertedWithCustomError(vesting, "NotEnoughSpareTokens").withArgs(0, 1);
  });

  it("one schedule per address: an active or revoked one cannot be overwritten", async function () {
    const { vesting, ram, start } = await loadFixture(withSchedule);
    const go = () => vesting.createSchedule(ram.address, 1, start + 1000, 0, 100, false);
    await expect(go()).to.be.revertedWithCustomError(vesting, "ScheduleExists");
    await vesting.revoke(ram.address); // revoked before the cliff, so total is now 0
    await expect(go()).to.be.revertedWithCustomError(vesting, "ScheduleExists");
  });

  it("ownership moves in two steps", async function () {
    const { vesting, owner, ram } = await loadFixture(deploy);
    await vesting.transferOwnership(ram.address);
    expect(await vesting.owner()).to.equal(owner.address);
    await vesting.connect(ram).acceptOwnership();
    expect(await vesting.owner()).to.equal(ram.address);
  });
});

describe("TokenVesting: the unlock line", function () {
  it("is 0 before the start, 0 until the cliff, and jumps at the exact cliff second", async function () {
    const { vesting, ram, start } = await loadFixture(withSchedule);
    expect(await vesting.vestedAt(ram.address, start - 1)).to.equal(0n);
    expect(await vesting.vestedAt(ram.address, start + 3 * MONTH - 1)).to.equal(0n);
    expect(await vesting.vestedAt(ram.address, start + 3 * MONTH)).to.equal(HIM(3000));
  });

  it("is a straight line after the cliff, and exactly the total from the end date on", async function () {
    const { vesting, ram, start } = await loadFixture(withSchedule);
    expect(await vesting.vestedAt(ram.address, start + 6 * MONTH)).to.equal(HIM(6000));
    expect(await vesting.vestedAt(ram.address, start + 12 * MONTH - 1)).to.be.lessThan(TOTAL);
    expect(await vesting.vestedAt(ram.address, start + 12 * MONTH)).to.equal(TOTAL);
    expect(await vesting.vestedAt(ram.address, start + 99 * YEAR)).to.equal(TOTAL);
  });

  it("an address with no schedule has 0 vested and cannot release", async function () {
    const { vesting, eve } = await loadFixture(withSchedule);
    expect(await vesting.vestedAt(eve.address, 2 ** 40)).to.equal(0n);
    expect(await vesting.releasable(eve.address)).to.equal(0n);
    await expect(vesting.connect(eve).release()).to.be.revertedWithCustomError(vesting, "NothingToRelease");
  });

  it("the largest allowed schedule over the longest time does not overflow", async function () {
    const { ram } = await loadFixture(deploy);
    const MAX = 2n ** 128n - 1n;
    const big = await ethers.deployContract("BigToken", [MAX]);
    const v = await ethers.deployContract("TokenVesting", [await big.getAddress()]);
    await big.transfer(await v.getAddress(), MAX);
    const s = (await time.latest()) + 100;
    await v.createSchedule(ram.address, MAX, s, 0, 10 * YEAR, false);
    expect(await v.vestedAt(ram.address, s + 10 * YEAR - 1)).to.equal((MAX * BigInt(10 * YEAR - 1)) / BigInt(10 * YEAR));
    await releaseAt(v, ram, s + 10 * YEAR);
    expect(await big.balanceOf(ram.address)).to.equal(MAX);
  });
});

describe("TokenVesting: early claims", function () {
  it("a claim one second before the cliff fails; at the cliff it pays exactly 3 months", async function () {
    const { vesting, ram, token, start } = await loadFixture(withSchedule);
    await expect(releaseAt(vesting, ram, start + 3 * MONTH - 1)).to.be.revertedWithCustomError(vesting, "NothingToRelease");
    await releaseAt(vesting, ram, start + 3 * MONTH);
    expect(await token.balanceOf(ram.address)).to.equal(HIM(3000));
  });

  it("claiming twice in the same second pays only once", async function () {
    const { vesting, ram, start, token } = await loadFixture(withSchedule);
    await releaseAt(vesting, ram, start + 6 * MONTH);
    const bal = await token.balanceOf(ram.address);
    expect(await vesting.releasable(ram.address)).to.equal(0n);
    await ethers.provider.send("evm_setAutomine", [false]);
    const a = await vesting.connect(ram).release({ gasLimit: 200000 });
    const b = await vesting.connect(ram).release({ gasLimit: 200000 });
    await ethers.provider.send("evm_setNextBlockTimestamp", [start + 7 * MONTH]);
    await ethers.provider.send("evm_mine");
    await ethers.provider.send("evm_setAutomine", [true]);
    expect((await a.wait()).status).to.equal(1);
    const failed = await b.wait().then(() => false, (e) => e.receipt.status === 0);
    expect(failed).to.equal(true); // the second claim in the block had nothing left
    expect(await token.balanceOf(ram.address)).to.equal(bal + HIM(1000));
  });

  it("nobody else can release someone's tokens or change where they go", async function () {
    const { vesting, ram, eve, token, start } = await loadFixture(withSchedule);
    await expect(releaseAt(vesting, eve, start + 6 * MONTH)).to.be.revertedWithCustomError(vesting, "NothingToRelease");
    expect(await token.balanceOf(eve.address)).to.equal(0n);
    expect(await vesting.releasable(ram.address)).to.equal(HIM(6000));
  });

  it("a beneficiary contract cannot claim twice while being paid (reentrancy)", async function () {
    const hook = await ethers.deployContract("HookToken");
    const vesting = await ethers.deployContract("TokenVesting", [await hook.getAddress()]);
    const bad = await ethers.deployContract("ReentrantBeneficiary");
    const badAddr = await bad.getAddress();
    await hook.transfer(await vesting.getAddress(), 1000n);
    const start = (await time.latest()) + 100;
    await vesting.createSchedule(badAddr, 1000n, start, 0, 100, false);
    await time.setNextBlockTimestamp(start + 50);
    await bad.attack(await vesting.getAddress());
    expect(await bad.attempts()).to.equal(1n);
    expect(await bad.successes()).to.equal(0n);
    expect(await hook.balanceOf(badAddr)).to.equal(500n);
    expect(await vesting.totalOwed()).to.equal(500n);
  });
});

describe("TokenVesting: rounding", function () {
  it("365 daily claims of a tiny 1,000-wei grant pay exactly 1,000 (naive per-claim maths pays 730)", async function () {
    const { vesting, ram, token } = await loadFixture(deploy);
    const start = (await time.latest()) + 100;
    await vesting.createSchedule(ram.address, 1000n, start, 0, YEAR, false);
    let naive = 0n;
    for (let d = 1; d <= 365; d++) {
      await releaseAt(vesting, ram, start + d * DAY);
      naive += (1000n * BigInt(DAY)) / BigInt(YEAR); // what "pay for time since last claim" would give
    }
    expect(await token.balanceOf(ram.address)).to.equal(1000n);
    expect(naive).to.equal(730n);
    expect(await vesting.totalOwed()).to.equal(0n);
  });

  it("claiming often and claiming once end at exactly the same total", async function () {
    const { vesting, ram, sita, token } = await loadFixture(deploy);
    const start = (await time.latest()) + 100;
    const odd = HIM(12000) + 7n; // does not divide evenly
    await vesting.createSchedule(ram.address, odd, start, 0, 12 * MONTH, false);
    await vesting.createSchedule(sita.address, odd, start, 0, 12 * MONTH, false);
    for (let m = 1; m <= 12; m++) await releaseAt(vesting, ram, start + m * MONTH + m);
    await releaseAt(vesting, sita, start + 13 * MONTH);
    expect(await token.balanceOf(ram.address)).to.equal(odd);
    expect(await token.balanceOf(sita.address)).to.equal(odd);
  });

  it("rounds down, in the contract's favour, while vesting", async function () {
    const { vesting, ram } = await loadFixture(deploy);
    const s = (await time.latest()) + 100;
    await vesting.createSchedule(ram.address, 10n, s, 0, 3, false);
    expect(await vesting.vestedAt(ram.address, s + 1)).to.equal(3n); // 3.33 -> 3
    expect(await vesting.vestedAt(ram.address, s + 2)).to.equal(6n); // 6.66 -> 6
    expect(await vesting.vestedAt(ram.address, s + 3)).to.equal(10n); // last step pays the dust
  });
});

describe("TokenVesting: revoke", function () {
  it("keeps what has vested claimable and frees only the unvested part", async function () {
    const { vesting, ram, token, start } = await loadFixture(withSchedule);
    await time.setNextBlockTimestamp(start + 6 * MONTH);
    await expect(vesting.revoke(ram.address)).to.emit(vesting, "Revoked").withArgs(ram.address, HIM(6000), HIM(6000));
    expect(await vesting.totalOwed()).to.equal(HIM(6000));
    expect(await vesting.spareTokens()).to.equal(FUNDED - HIM(6000));
    await time.increase(5 * YEAR); // vesting has stopped: nothing more unlocks
    expect(await vesting.releasable(ram.address)).to.equal(HIM(6000));
    await vesting.connect(ram).release();
    expect(await token.balanceOf(ram.address)).to.equal(HIM(6000));
    await expect(vesting.connect(ram).release()).to.be.revertedWithCustomError(vesting, "NothingToRelease");
  });

  it("revoke after a partial claim does not pay the same tokens twice", async function () {
    const { vesting, ram, token, start } = await loadFixture(withSchedule);
    await releaseAt(vesting, ram, start + 4 * MONTH);
    await time.setNextBlockTimestamp(start + 6 * MONTH);
    await vesting.revoke(ram.address);
    await vesting.connect(ram).release();
    expect(await token.balanceOf(ram.address)).to.equal(HIM(6000));
    expect(await vesting.totalOwed()).to.equal(0n);
  });

  it("before the cliff everything returns to spare", async function () {
    const { vesting, ram, start } = await loadFixture(withSchedule);
    await time.setNextBlockTimestamp(start + MONTH);
    await vesting.revoke(ram.address);
    expect(await vesting.totalOwed()).to.equal(0n);
    expect(await vesting.spareTokens()).to.equal(FUNDED);
    await expect(vesting.connect(ram).release()).to.be.revertedWithCustomError(vesting, "NothingToRelease");
  });

  it("cannot revoke twice, a non-revocable schedule, or a schedule that does not exist", async function () {
    const { vesting, ram, sita, eve } = await loadFixture(withSchedule);
    await vesting.createSchedule(sita.address, 100, (await time.latest()) + 100, 0, 100, false);
    await expect(vesting.revoke(sita.address)).to.be.revertedWithCustomError(vesting, "NotRevocable");
    await expect(vesting.revoke(eve.address)).to.be.revertedWithCustomError(vesting, "NoSchedule");
    await vesting.revoke(ram.address);
    await expect(vesting.revoke(ram.address)).to.be.revertedWithCustomError(vesting, "AlreadyRevoked");
  });
});

describe("TokenVesting: the owner cannot touch promised tokens", function () {
  it("withdraws spare tokens only; one wei more fails", async function () {
    const { vesting, owner, token, eve } = await loadFixture(withSchedule);
    const spare = FUNDED - TOTAL;
    await expect(vesting.withdrawSpare(owner.address, spare + 1n)).to.be.revertedWithCustomError(vesting, "NotEnoughSpareTokens");
    await expect(vesting.withdrawSpare(owner.address, 0)).to.be.revertedWithCustomError(vesting, "NotEnoughSpareTokens");
    await expect(vesting.withdrawSpare(ethers.ZeroAddress, 1)).to.be.revertedWithCustomError(vesting, "ZeroAddress");
    await expect(vesting.withdrawSpare(eve.address, spare)).to.emit(vesting, "SpareWithdrawn").withArgs(eve.address, spare);
    expect(await token.balanceOf(eve.address)).to.equal(spare);
    expect(await vesting.spareTokens()).to.equal(0n);
  });

  it("after the owner takes all spare tokens the beneficiary still gets everything", async function () {
    const { vesting, owner, ram, token, start } = await loadFixture(withSchedule);
    await vesting.withdrawSpare(owner.address, FUNDED - TOTAL);
    await releaseAt(vesting, ram, start + 12 * MONTH);
    expect(await token.balanceOf(ram.address)).to.equal(TOTAL);
  });

  it("a non-revocable schedule pays out in full even if the owner renounces", async function () {
    const { vesting, sita, token } = await loadFixture(deploy);
    const s = (await time.latest()) + 100;
    await vesting.createSchedule(sita.address, HIM(500), s, 0, YEAR, false);
    await vesting.renounceOwnership();
    await releaseAt(vesting, sita, s + YEAR);
    expect(await token.balanceOf(sita.address)).to.equal(HIM(500));
  });
});

describe("TokenVesting: fuzz", function () {
  it("100 random histories of claims, revokes and waits keep the books exact", async function () {
    this.timeout(180000);
    const f = await loadFixture(deploy);
    const { vesting, token, owner, ram, sita, eve } = f;
    const people = [ram, sita, eve];
    const action = fc.record({ who: fc.nat(2), kind: fc.nat(9), wait: fc.integer({ min: 1, max: 20 * MONTH }) });
    await fc.assert(
      fc.asyncProperty(fc.array(action, { minLength: 1, maxLength: 14 }), fc.tuple(fc.bigInt({ min: 1n, max: 10n ** 22n }), fc.bigInt({ min: 1n, max: 10n ** 22n }), fc.bigInt({ min: 1n, max: 10n ** 22n })), async (steps, totals) => {
        const v = await ethers.deployContract("TokenVesting", [await token.getAddress()]);
        const addr = await v.getAddress();
        await token.transfer(addr, totals[0] + totals[1] + totals[2]);
        const start = (await time.latest()) + 100;
        const sch = [];
        for (let i = 0; i < 3; i++) {
          await v.createSchedule(people[i].address, totals[i], start, 2 * MONTH, 12 * MONTH + i, true);
          sch.push({ total: totals[i], paid: 0n, revoked: false, dur: BigInt(12 * MONTH + i) });
        }
        const vest = (s, t) => {
          if (s.revoked) return s.total;
          const e = BigInt(t - start);
          if (t < start + 2 * MONTH) return 0n;
          if (e >= s.dur) return s.total;
          return (s.total * e) / s.dur;
        };
        let t = start;
        for (const st of steps) {
          t += st.wait;
          await time.setNextBlockTimestamp(t);
          const s = sch[st.who];
          if (st.kind === 0 && !s.revoked) {
            await v.revoke(people[st.who].address);
            s.total = vest(s, t);
            s.revoked = true;
          } else {
            const amount = vest(s, t) - s.paid;
            const tx = v.connect(people[st.who]).release();
            if (amount === 0n) await expect(tx).to.be.revertedWithCustomError(v, "NothingToRelease");
            else {
              await tx;
              s.paid += amount;
            }
          }
          const owed = sch.reduce((a, x) => a + x.total - x.paid, 0n);
          expect(await v.totalOwed()).to.equal(owed);
          expect(await token.balanceOf(addr)).to.be.greaterThanOrEqual(owed);
        }
        // Afterwards everyone can still collect exactly what they are owed, and no more.
        t += 13 * MONTH;
        for (let i = 0; i < 3; i++) {
          const s = sch[i];
          const left = s.total - s.paid;
          await time.setNextBlockTimestamp(++t);
          if (left > 0n) await v.connect(people[i]).release();
          else await expect(v.connect(people[i]).release()).to.be.reverted;
          s.paid = s.total;
        }
        expect(await v.totalOwed()).to.equal(0n);
        const spare = await v.spareTokens();
        if (spare > 0n) await v.withdrawSpare(owner.address, spare);
        expect(await token.balanceOf(addr)).to.equal(0n);
        // Hand all tokens back so each run starts from the same place.
        for (const p of people) {
          const b = await token.balanceOf(p.address);
          if (b > 0n) await token.connect(p).transfer(owner.address, b);
        }
      }),
      { numRuns: 100 }
    );
  });
});
