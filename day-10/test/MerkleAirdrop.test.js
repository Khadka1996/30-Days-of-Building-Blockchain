const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time, setBalance } = require("@nomicfoundation/hardhat-network-helpers");
const fc = require("fast-check");
const { buildAirdrop } = require("../lib/airdrop");

const HIM = (n) => ethers.parseEther(String(n));
const DAY = 24 * 60 * 60;
const PERIOD = 30 * DAY;
const AMOUNTS = [HIM(100), HIM(250), HIM(50), HIM(600)];
const ZERO32 = ethers.ZeroHash;

async function deployAirdrop(token, airdrop, treasury, period = PERIOD) {
  return ethers.deployContract("MerkleAirdrop", [await token.getAddress(), airdrop.root, treasury.address, airdrop.total, period]);
}

async function deploy() {
  const [treasury, ram, sita, hari, gita, eve] = await ethers.getSigners();
  const token = await ethers.deployContract("HimalToken");
  const list = [ram, sita, hari, gita].map((s, i) => ({ address: s.address, amount: AMOUNTS[i] }));
  const ad = buildAirdrop(list);
  const drop = await deployAirdrop(token, ad, treasury);
  return { treasury, ram, sita, hari, gita, eve, token, ad, drop, addr: await drop.getAddress() };
}

async function funded() {
  const f = await deploy();
  await f.token.approve(f.addr, f.ad.total);
  await f.drop.fund();
  return { ...f, deadline: await f.drop.deadline() };
}

describe("MerkleAirdrop: setup", function () {
  it("stores the root, treasury, total and period", async function () {
    const { drop, ad, treasury, token } = await loadFixture(deploy);
    expect(await drop.merkleRoot()).to.equal(ad.root);
    expect(await drop.treasury()).to.equal(treasury.address);
    expect(await drop.totalAllocation()).to.equal(HIM(1000));
    expect(await drop.claimPeriod()).to.equal(PERIOD);
    expect(await drop.token()).to.equal(await token.getAddress());
    expect(await drop.deadline()).to.equal(0);
  });

  it("rejects bad constructor values", async function () {
    const { token, ad, treasury } = await loadFixture(deploy);
    const F = await ethers.getContractFactory("MerkleAirdrop");
    const t = await token.getAddress();
    await expect(F.deploy(ethers.ZeroAddress, ad.root, treasury.address, 1, PERIOD)).to.be.revertedWithCustomError(F, "ZeroAddress");
    await expect(F.deploy(t, ad.root, ethers.ZeroAddress, 1, PERIOD)).to.be.revertedWithCustomError(F, "ZeroAddress");
    await expect(F.deploy(t, ZERO32, treasury.address, 1, PERIOD)).to.be.revertedWithCustomError(F, "ZeroRoot");
    await expect(F.deploy(t, ad.root, treasury.address, 0, PERIOD)).to.be.revertedWithCustomError(F, "ZeroAllocation");
    await expect(F.deploy(t, ad.root, treasury.address, 1, DAY - 1)).to.be.revertedWithCustomError(F, "BadClaimPeriod");
    await expect(F.deploy(t, ad.root, treasury.address, 1, 365 * DAY + 1)).to.be.revertedWithCustomError(F, "BadClaimPeriod");
    await F.deploy(t, ad.root, treasury.address, 1, DAY);
    await F.deploy(t, ad.root, treasury.address, 1, 365 * DAY);
  });
});

describe("MerkleAirdrop: funding", function () {
  it("only the treasury can fund", async function () {
    const { drop, eve, token, addr, ad } = await loadFixture(deploy);
    await token.transfer(eve.address, ad.total);
    await token.connect(eve).approve(addr, ad.total);
    await expect(drop.connect(eve).fund()).to.be.revertedWithCustomError(drop, "NotTreasury");
  });

  it("funding moves the exact total and starts the full claim window", async function () {
    const { drop, token, addr, ad } = await loadFixture(deploy);
    await token.approve(addr, ad.total);
    const t = (await time.latest()) + 500;
    await time.setNextBlockTimestamp(t);
    await expect(drop.fund()).to.emit(drop, "Funded").withArgs(ad.total, t + PERIOD);
    expect(await token.balanceOf(addr)).to.equal(ad.total);
    expect(await drop.deadline()).to.equal(t + PERIOD);
  });

  it("cannot be funded twice", async function () {
    const { drop, token, addr, ad } = await loadFixture(funded);
    await token.approve(addr, ad.total);
    await expect(drop.fund()).to.be.revertedWithCustomError(drop, "AlreadyFunded");
  });

  it("refuses a token that delivers less than the total (fee on transfer)", async function () {
    const { treasury, ad } = await loadFixture(deploy);
    const fee = await ethers.deployContract("ShortToken");
    const d = await deployAirdrop(fee, ad, treasury);
    await fee.approve(await d.getAddress(), ad.total);
    await expect(d.fund()).to.be.revertedWithCustomError(d, "InsufficientFunding");
  });

  it("no claims and no sweep before funding", async function () {
    const { drop, ad, ram } = await loadFixture(deploy);
    await expect(drop.connect(ram).claim(0, AMOUNTS[0], ad.proofFor(0))).to.be.revertedWithCustomError(drop, "NotFunded");
    await expect(drop.sweep()).to.be.revertedWithCustomError(drop, "NotFunded");
  });
});

describe("MerkleAirdrop: claiming", function () {
  it("pays the right amount, marks it claimed and emits the event", async function () {
    const { drop, ad, sita, token } = await loadFixture(funded);
    await expect(drop.connect(sita).claim(1, AMOUNTS[1], ad.proofFor(1)))
      .to.emit(drop, "Claimed").withArgs(1, sita.address, AMOUNTS[1]);
    expect(await token.balanceOf(sita.address)).to.equal(AMOUNTS[1]);
    expect(await drop.isClaimed(1)).to.equal(true);
    expect(await drop.isClaimed(0)).to.equal(false);
    expect(await drop.totalClaimed()).to.equal(AMOUNTS[1]);
  });

  it("claiming twice fails", async function () {
    const { drop, ad, ram } = await loadFixture(funded);
    await drop.connect(ram).claim(0, AMOUNTS[0], ad.proofFor(0));
    await expect(drop.connect(ram).claim(0, AMOUNTS[0], ad.proofFor(0)))
      .to.be.revertedWithCustomError(drop, "AlreadyClaimed").withArgs(0);
  });

  it("claims work in any order and the contract ends empty", async function () {
    const { drop, ad, ram, sita, hari, gita, token, addr } = await loadFixture(funded);
    for (const [s, i] of [[gita, 3], [ram, 0], [hari, 2], [sita, 1]]) {
      await drop.connect(s).claim(i, AMOUNTS[i], ad.proofFor(i));
    }
    expect(await token.balanceOf(addr)).to.equal(0);
    expect(await drop.totalClaimed()).to.equal(ad.total);
  });

  it("a claim works on the last second and fails one second later", async function () {
    const { drop, ad, ram, sita, deadline } = await loadFixture(funded);
    await time.setNextBlockTimestamp(deadline);
    await drop.connect(ram).claim(0, AMOUNTS[0], ad.proofFor(0));
    await time.setNextBlockTimestamp(deadline + 1n);
    await expect(drop.connect(sita).claim(1, AMOUNTS[1], ad.proofFor(1))).to.be.revertedWithCustomError(drop, "ClaimsClosed");
  });
});

describe("MerkleAirdrop: fake proofs", function () {
  it("a stranger cannot use someone else's proof (copied from the mempool)", async function () {
    const { drop, ad, eve } = await loadFixture(funded);
    await expect(drop.connect(eve).claim(0, AMOUNTS[0], ad.proofFor(0))).to.be.revertedWithCustomError(drop, "InvalidProof");
  });

  it("a real member cannot raise their amount", async function () {
    const { drop, ad, ram } = await loadFixture(funded);
    await expect(drop.connect(ram).claim(0, AMOUNTS[0] + 1n, ad.proofFor(0))).to.be.revertedWithCustomError(drop, "InvalidProof");
  });

  it("a real member cannot use another index, an empty proof or a changed proof", async function () {
    const { drop, ad, ram } = await loadFixture(funded);
    await expect(drop.connect(ram).claim(1, AMOUNTS[0], ad.proofFor(0))).to.be.revertedWithCustomError(drop, "InvalidProof");
    await expect(drop.connect(ram).claim(0, AMOUNTS[0], [])).to.be.revertedWithCustomError(drop, "InvalidProof");
    const bad = [...ad.proofFor(0)];
    bad[0] = ethers.id("fake");
    await expect(drop.connect(ram).claim(0, AMOUNTS[0], bad)).to.be.revertedWithCustomError(drop, "InvalidProof");
  });

  it("an inner node of the tree cannot be passed off as a leaf", async function () {
    const { drop, ad, eve } = await loadFixture(funded);
    const proof = ad.proofFor(0);
    // Everything from the sibling upward is a valid path from an inner node to the root.
    expect(await drop.verifyProof(0, eve.address, 0, proof.slice(1))).to.equal(false);
    await expect(drop.connect(eve).claim(0, 0, proof.slice(1))).to.be.revertedWithCustomError(drop, "InvalidProof");
  });

  it("a single-hash leaf is rejected (the leaf must be double hashed)", async function () {
    const { treasury, token, ram } = await loadFixture(deploy);
    const single = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "address", "uint256"], [0, ram.address, HIM(1)]));
    const d = await ethers.deployContract("MerkleAirdrop", [await token.getAddress(), single, treasury.address, HIM(1), PERIOD]);
    await token.approve(await d.getAddress(), HIM(1));
    await d.fund();
    await expect(d.connect(ram).claim(0, HIM(1), [])).to.be.revertedWithCustomError(d, "InvalidProof");
  });

  it("a proof from a different list does not work", async function () {
    const { drop, ram, eve } = await loadFixture(funded);
    const other = buildAirdrop([{ address: ram.address, amount: HIM(900) }, { address: eve.address, amount: HIM(900) }]);
    await expect(drop.connect(eve).claim(1, HIM(900), other.proofFor(1))).to.be.revertedWithCustomError(drop, "InvalidProof");
  });

  it("verifyProof agrees with a hand-written Merkle walk", async function () {
    const { drop, ad, sita } = await loadFixture(funded);
    const coder = ethers.AbiCoder.defaultAbiCoder();
    let node = ethers.keccak256(ethers.keccak256(coder.encode(["uint256", "address", "uint256"], [1, sita.address, AMOUNTS[1]])));
    for (const sib of ad.proofFor(1)) {
      const [a, b] = BigInt(node) < BigInt(sib) ? [node, sib] : [sib, node];
      node = ethers.keccak256(ethers.concat([a, b]));
    }
    expect(node).to.equal(ad.root);
    expect(await drop.verifyProof(1, sita.address, AMOUNTS[1], ad.proofFor(1))).to.equal(true);
  });

  it("a list that promises more than the total cannot pay past the total", async function () {
    const { treasury, token, ram, sita } = await loadFixture(deploy);
    const ad = buildAirdrop([{ address: ram.address, amount: HIM(60) }, { address: sita.address, amount: HIM(60) }]);
    const d = await ethers.deployContract("MerkleAirdrop", [await token.getAddress(), ad.root, treasury.address, HIM(100), PERIOD]);
    await token.approve(await d.getAddress(), HIM(100));
    await d.fund();
    await d.connect(ram).claim(0, HIM(60), ad.proofFor(0));
    await expect(d.connect(sita).claim(1, HIM(60), ad.proofFor(1))).to.be.revertedWithCustomError(d, "ExceedsAllocation");
  });
});

describe("MerkleAirdrop: reentrancy", function () {
  it("a hostile token that calls claim again during payment cannot claim twice", async function () {
    const [treasury] = await ethers.getSigners();
    const bad = await ethers.deployContract("ReentrantToken");
    const badAddr = await bad.getAddress();
    const ad = buildAirdrop([{ address: badAddr, amount: HIM(10) }, { address: treasury.address, amount: HIM(10) }]);
    const d = await ethers.deployContract("MerkleAirdrop", [badAddr, ad.root, treasury.address, ad.total, PERIOD]);
    const addr = await d.getAddress();
    await bad.approve(addr, ad.total);
    await d.fund();
    await bad.arm(addr, 0, HIM(10), ad.proofFor(0));
    await bad.claimFor(0, HIM(10), ad.proofFor(0));
    expect(await bad.attacked()).to.equal(true);
    expect(await bad.attackSucceeded()).to.equal(false);
    expect(await d.totalClaimed()).to.equal(HIM(10));
    expect(await bad.balanceOf(addr)).to.equal(HIM(10));
  });
});

describe("MerkleAirdrop: sweep", function () {
  it("cannot sweep during the claim window, including the last second", async function () {
    const { drop, deadline } = await loadFixture(funded);
    await expect(drop.sweep()).to.be.revertedWithCustomError(drop, "ClaimsStillOpen");
    await time.setNextBlockTimestamp(deadline);
    await expect(drop.sweep()).to.be.revertedWithCustomError(drop, "ClaimsStillOpen");
  });

  it("after the deadline anyone can trigger it, but tokens only go to the treasury", async function () {
    const { drop, ad, ram, eve, token, treasury, addr, deadline } = await loadFixture(funded);
    await drop.connect(ram).claim(0, AMOUNTS[0], ad.proofFor(0));
    await time.setNextBlockTimestamp(deadline + 1n);
    const left = ad.total - AMOUNTS[0];
    await expect(drop.connect(eve).sweep()).to.emit(drop, "Swept").withArgs(treasury.address, left);
    expect(await token.balanceOf(addr)).to.equal(0);
    expect(await token.balanceOf(eve.address)).to.equal(0);
    await expect(drop.sweep()).to.be.revertedWithCustomError(drop, "NothingToSweep");
  });

  it("nothing to sweep when everyone has claimed", async function () {
    const { drop, ad, ram, sita, hari, gita, deadline } = await loadFixture(funded);
    for (const [s, i] of [[ram, 0], [sita, 1], [hari, 2], [gita, 3]]) await drop.connect(s).claim(i, AMOUNTS[i], ad.proofFor(i));
    await time.setNextBlockTimestamp(deadline + 1n);
    await expect(drop.sweep()).to.be.revertedWithCustomError(drop, "NothingToSweep");
  });
});

describe("lib/airdrop: list checks", function () {
  const a = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  const b = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
  it("rejects an empty list, duplicates (any letter case), bad addresses and zero amounts", function () {
    expect(() => buildAirdrop([])).to.throw("empty");
    expect(() => buildAirdrop([{ address: a, amount: 1 }, { address: a.toLowerCase(), amount: 1 }])).to.throw("duplicate");
    expect(() => buildAirdrop([{ address: "0x1234", amount: 1 }])).to.throw();
    expect(() => buildAirdrop([{ address: ethers.ZeroAddress, amount: 1 }])).to.throw("zero address");
    expect(() => buildAirdrop([{ address: a, amount: 0 }])).to.throw("above zero");
    expect(() => buildAirdrop([{ address: a, amount: -5 }])).to.throw("above zero");
  });
  it("a list of one needs an empty proof, and a list of two needs one hash", function () {
    const one = buildAirdrop([{ address: a, amount: 1 }]);
    expect(one.proofFor(0)).to.deep.equal([]);
    const x = buildAirdrop([{ address: a, amount: 1 }, { address: b, amount: 2 }]);
    expect(x.proofFor(0).length).to.equal(1);
    expect(x.root).to.not.equal(one.root);
  });

  it("adds up the total", function () {
    expect(buildAirdrop([{ address: a, amount: 2 }, { address: b, amount: 3 }]).total).to.equal(5n);
  });
});

describe("MerkleAirdrop: 1,000 real claims", function () {
  it("every one of 1,000 addresses claims once, nobody claims twice, the books balance", async function () {
    this.timeout(180000);
    const [treasury] = await ethers.getSigners();
    const wallets = Array.from({ length: 1000 }, (_, i) => new ethers.Wallet(ethers.id(`day10-user-${i}`), ethers.provider));
    const ad = buildAirdrop(wallets.map((w, i) => ({ address: w.address, amount: HIM(1 + (i % 7)) })));
    const token = await ethers.deployContract("HimalToken");
    const drop = await deployAirdrop(token, ad, treasury);
    const addr = await drop.getAddress();
    await token.approve(addr, ad.total);
    await drop.fund();

    let maxDepth = 0;
    for (let i = 0; i < 1000; i++) {
      await setBalance(wallets[i].address, HIM(1));
      const proof = ad.proofFor(i);
      maxDepth = Math.max(maxDepth, proof.length);
      await drop.connect(wallets[i]).claim(i, ad.values[i][2], proof);
    }
    expect(maxDepth).to.equal(10);
    expect(await token.balanceOf(addr)).to.equal(0);
    expect(await drop.totalClaimed()).to.equal(ad.total);
    await expect(drop.connect(wallets[7]).claim(7, ad.values[7][2], ad.proofFor(7)))
      .to.be.revertedWithCustomError(drop, "AlreadyClaimed");
    for (const i of [0, 1, 255, 256, 511, 512, 999]) expect(await drop.isClaimed(i)).to.equal(true);
  });
});

describe("MerkleAirdrop: fuzz", function () {
  it("random lists, random order, random cheating: only honest claims pay, and exactly once", async function () {
    this.timeout(300000);
    const [treasury] = await ethers.getSigners();
    const token = await ethers.deployContract("HimalToken");
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.bigInt({ min: 1n, max: 10n ** 21n }), { minLength: 1, maxLength: 40 }),
        fc.array(fc.tuple(fc.nat(), fc.constantFrom("honest", "repeat", "amount", "index", "stranger")), { minLength: 1, maxLength: 60 }),
        fc.integer({ min: 0, max: 1 << 30 }),
        async (amounts, steps, salt) => {
          const wallets = amounts.map((_, i) => new ethers.Wallet(ethers.id(`fz-${salt}-${i}`), ethers.provider));
          const stranger = new ethers.Wallet(ethers.id(`fz-stranger-${salt}`), ethers.provider);
          const ad = buildAirdrop(wallets.map((w, i) => ({ address: w.address, amount: amounts[i] })));
          const drop = await deployAirdrop(token, ad, treasury);
          const addr = await drop.getAddress();
          await token.approve(addr, ad.total);
          await drop.fund();
          await Promise.all([...wallets, stranger].map((w) => setBalance(w.address, HIM(1))));

          const done = new Set();
          for (const [r, kind] of steps) {
            const i = r % amounts.length;
            const w = wallets[i];
            const c = drop.connect(w);
            if (kind === "honest") {
              if (done.has(i)) {
                await expect(c.claim(i, amounts[i], ad.proofFor(i))).to.be.revertedWithCustomError(drop, "AlreadyClaimed");
              } else {
                await c.claim(i, amounts[i], ad.proofFor(i));
                done.add(i);
              }
            } else if (kind === "repeat" && done.has(i)) {
              await expect(c.claim(i, amounts[i], ad.proofFor(i))).to.be.revertedWithCustomError(drop, "AlreadyClaimed");
            } else if (kind === "amount" && !done.has(i)) {
              await expect(c.claim(i, amounts[i] + 1n, ad.proofFor(i))).to.be.revertedWithCustomError(drop, "InvalidProof");
            } else if (kind === "index" && amounts.length > 1) {
              const j = (i + 1) % amounts.length;
              if (!done.has(j)) await expect(c.claim(j, amounts[i], ad.proofFor(i))).to.be.revertedWithCustomError(drop, "InvalidProof");
            } else if (kind === "stranger" && !done.has(i)) {
              await expect(drop.connect(stranger).claim(i, amounts[i], ad.proofFor(i))).to.be.revertedWithCustomError(drop, "InvalidProof");
            }
            const paid = [...done].reduce((s, k) => s + amounts[k], 0n);
            expect(await drop.totalClaimed()).to.equal(paid);
            expect(await token.balanceOf(addr)).to.equal(ad.total - paid);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
