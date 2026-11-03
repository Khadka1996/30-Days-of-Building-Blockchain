const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const fc = require("fast-check");

const ONE = ethers.parseEther("1");

describe("MultiSigWallet", function () {
  // 3 owners (alice, bob, carol), 2 approvals needed, 10 ETH inside.
  async function deploy() {
    const signers = await ethers.getSigners();
    const [alice, bob, carol, dave, eve] = signers;
    const wallet = await ethers.deployContract("MultiSigWallet", [[alice.address, bob.address, carol.address], 2]);
    await alice.sendTransaction({ to: await wallet.getAddress(), value: 10n * ONE });
    const counter = await ethers.deployContract("Counter");
    return { wallet, counter, alice, bob, carol, dave, eve, signers };
  }

  // Helper: propose a call from the wallet to itself (owner/threshold changes) and run it with 2 approvals.
  async function governed(wallet, [p, q], fn, args) {
    const data = wallet.interface.encodeFunctionData(fn, args);
    const id = await wallet.transactionCount();
    await wallet.connect(p).submit(await wallet.getAddress(), 0, data);
    await wallet.connect(p).approve(id);
    await wallet.connect(q).approve(id);
    return wallet.connect(p).execute(id);
  }

  describe("setup", function () {
    it("stores 3 owners and a threshold of 2", async function () {
      const { wallet, alice, bob, carol, dave } = await loadFixture(deploy);
      expect(await wallet.getOwners()).to.deep.equal([alice.address, bob.address, carol.address]);
      expect(await wallet.threshold()).to.equal(2n);
      expect(await wallet.isOwner(dave.address)).to.equal(false);
    });

    it("rejects zero, duplicate or self owners and a bad threshold", async function () {
      const { alice, bob } = await loadFixture(deploy);
      const F = await ethers.getContractFactory("MultiSigWallet");
      await expect(F.deploy([], 1)).to.be.revertedWithCustomError(F, "BadOwnerCount");
      await expect(F.deploy([alice.address, ethers.ZeroAddress], 1)).to.be.revertedWithCustomError(F, "InvalidOwner");
      await expect(F.deploy([alice.address, alice.address], 1)).to.be.revertedWithCustomError(F, "DuplicateOwner");
      await expect(F.deploy([alice.address, bob.address], 0)).to.be.revertedWithCustomError(F, "BadThreshold");
      await expect(F.deploy([alice.address, bob.address], 3)).to.be.revertedWithCustomError(F, "BadThreshold");
      const eleven = Array.from({ length: 11 }, () => ethers.Wallet.createRandom().address);
      await expect(F.deploy(eleven, 2)).to.be.revertedWithCustomError(F, "BadOwnerCount");
    });

    it("accepts ETH from anyone and emits Deposit", async function () {
      const { wallet, dave } = await loadFixture(deploy);
      await expect(dave.sendTransaction({ to: await wallet.getAddress(), value: ONE }))
        .to.emit(wallet, "Deposit").withArgs(dave.address, ONE, 11n * ONE);
    });
  });

  describe("a 2-of-3 payment", function () {
    it("pays only after 2 approvals and emits every step", async function () {
      const { wallet, alice, bob, dave } = await loadFixture(deploy);
      await expect(wallet.connect(alice).submit(dave.address, ONE, "0x"))
        .to.emit(wallet, "Submitted").withArgs(0, alice.address, dave.address, ONE, "0x");
      await expect(wallet.connect(alice).approve(0)).to.emit(wallet, "Approved").withArgs(0, alice.address);
      await expect(wallet.connect(alice).execute(0))
        .to.be.revertedWithCustomError(wallet, "NotEnoughApprovals").withArgs(0, 1, 2);
      await wallet.connect(bob).approve(0);
      await expect(wallet.connect(bob).execute(0)).to.changeEtherBalances([wallet, dave], [-ONE, ONE]);
      const t = await wallet.getTransaction(0);
      expect(t.executed).to.equal(true);
      expect(t.approvals).to.equal(2n);
    });

    it("can call another contract with data", async function () {
      const { wallet, counter, alice, carol } = await loadFixture(deploy);
      const data = counter.interface.encodeFunctionData("increment", [7]);
      await wallet.connect(alice).submit(await counter.getAddress(), 0, data);
      await wallet.connect(alice).approve(0);
      await wallet.connect(carol).approve(0);
      await expect(wallet.connect(carol).execute(0)).to.emit(wallet, "Executed").withArgs(0, carol.address);
      expect(await counter.count()).to.equal(7n);
      expect(await counter.lastCaller()).to.equal(await wallet.getAddress());
    });

    it("a failed call reverts with the reason and the proposal stays pending", async function () {
      const { wallet, counter, alice, bob } = await loadFixture(deploy);
      const data = counter.interface.encodeFunctionData("fail");
      await wallet.connect(alice).submit(await counter.getAddress(), 0, data);
      await wallet.connect(alice).approve(0);
      await wallet.connect(bob).approve(0);
      await expect(wallet.connect(alice).execute(0)).to.be.revertedWithCustomError(wallet, "ExecutionFailed");
      expect((await wallet.getTransaction(0)).executed).to.equal(false);
    });

    it("sending more ETH than the wallet holds fails safely", async function () {
      const { wallet, alice, bob, dave } = await loadFixture(deploy);
      await wallet.connect(alice).submit(dave.address, 11n * ONE, "0x");
      await wallet.connect(alice).approve(0);
      await wallet.connect(bob).approve(0);
      await expect(wallet.connect(alice).execute(0)).to.be.revertedWithCustomError(wallet, "ExecutionFailed");
    });

    it("rejects unknown ids and the zero address as target", async function () {
      const { wallet, alice } = await loadFixture(deploy);
      await expect(wallet.connect(alice).approve(5)).to.be.revertedWithCustomError(wallet, "TxNotFound").withArgs(5);
      await expect(wallet.getTransaction(0)).to.be.revertedWithCustomError(wallet, "TxNotFound");
      await expect(wallet.connect(alice).submit(ethers.ZeroAddress, ONE, "0x"))
        .to.be.revertedWithCustomError(wallet, "ZeroTarget");
    });

    it("revoke takes an approval back", async function () {
      const { wallet, alice, bob, dave } = await loadFixture(deploy);
      await wallet.connect(alice).submit(dave.address, ONE, "0x");
      await wallet.connect(alice).approve(0);
      await wallet.connect(bob).approve(0);
      await expect(wallet.connect(bob).revoke(0)).to.emit(wallet, "Revoked").withArgs(0, bob.address);
      await expect(wallet.connect(bob).revoke(0)).to.be.revertedWithCustomError(wallet, "NotApproved");
      await expect(wallet.connect(alice).execute(0)).to.be.revertedWithCustomError(wallet, "NotEnoughApprovals");
    });
  });

  describe("security: strangers", function () {
    it("a non-owner cannot submit, approve, revoke or execute", async function () {
      const { wallet, alice, bob, eve } = await loadFixture(deploy);
      await wallet.connect(alice).submit(eve.address, ONE, "0x");
      await wallet.connect(alice).approve(0);
      await wallet.connect(bob).approve(0);
      for (const call of [
        () => wallet.connect(eve).submit(eve.address, ONE, "0x"),
        () => wallet.connect(eve).approve(0),
        () => wallet.connect(eve).revoke(0),
        () => wallet.connect(eve).execute(0),
      ]) {
        await expect(call()).to.be.revertedWithCustomError(wallet, "NotOwner").withArgs(eve.address);
      }
    });

    it("owners cannot change owners or the threshold directly, only through a proposal", async function () {
      const { wallet, alice, dave } = await loadFixture(deploy);
      await expect(wallet.connect(alice).addOwner(dave.address)).to.be.revertedWithCustomError(wallet, "OnlyWallet");
      await expect(wallet.connect(alice).removeOwner(alice.address)).to.be.revertedWithCustomError(wallet, "OnlyWallet");
      await expect(wallet.connect(alice).changeThreshold(1)).to.be.revertedWithCustomError(wallet, "OnlyWallet");
    });
  });

  describe("security: approving twice", function () {
    it("one owner cannot approve the same proposal twice", async function () {
      const { wallet, alice, dave } = await loadFixture(deploy);
      await wallet.connect(alice).submit(dave.address, ONE, "0x");
      await wallet.connect(alice).approve(0);
      await expect(wallet.connect(alice).approve(0))
        .to.be.revertedWithCustomError(wallet, "AlreadyApproved").withArgs(0, alice.address);
      expect((await wallet.getTransaction(0)).approvals).to.equal(1n);
    });

    it("approve → revoke → approve still counts as one", async function () {
      const { wallet, alice, dave } = await loadFixture(deploy);
      await wallet.connect(alice).submit(dave.address, ONE, "0x");
      await wallet.connect(alice).approve(0);
      await wallet.connect(alice).revoke(0);
      await wallet.connect(alice).approve(0);
      await expect(wallet.connect(alice).execute(0))
        .to.be.revertedWithCustomError(wallet, "NotEnoughApprovals").withArgs(0, 1, 2);
    });
  });

  describe("security: replay", function () {
    it("an executed proposal can never run again", async function () {
      const { wallet, alice, bob, carol, dave } = await loadFixture(deploy);
      await wallet.connect(alice).submit(dave.address, ONE, "0x");
      await wallet.connect(alice).approve(0);
      await wallet.connect(bob).approve(0);
      await wallet.connect(alice).execute(0);
      await expect(wallet.connect(bob).execute(0)).to.be.revertedWithCustomError(wallet, "AlreadyExecuted").withArgs(0);
      await expect(wallet.connect(carol).approve(0)).to.be.revertedWithCustomError(wallet, "AlreadyExecuted");
      await expect(wallet.connect(bob).revoke(0)).to.be.revertedWithCustomError(wallet, "AlreadyExecuted");
    });

    it("two identical payments are two separate proposals with separate approvals", async function () {
      const { wallet, alice, bob, dave } = await loadFixture(deploy);
      await wallet.connect(alice).submit(dave.address, ONE, "0x");
      await wallet.connect(alice).submit(dave.address, ONE, "0x");
      await wallet.connect(alice).approve(0);
      await wallet.connect(bob).approve(0);
      await wallet.connect(alice).execute(0);
      await expect(wallet.connect(alice).execute(1)).to.be.revertedWithCustomError(wallet, "NotEnoughApprovals");
    });

    // An owner contract (the attacker) is paid by proposal #0 and #1 is also approved.
    async function deployWithAttacker() {
      const { alice, bob } = await deploy();
      const attacker = await ethers.deployContract("ReentrantOwner");
      const attackerAddr = await attacker.getAddress();
      const wallet = await ethers.deployContract("MultiSigWallet", [[alice.address, bob.address, attackerAddr], 2]);
      await alice.sendTransaction({ to: await wallet.getAddress(), value: 5n * ONE });
      await attacker.setWallet(await wallet.getAddress());
      for (const id of [0, 1]) {
        await attacker.propose(attackerAddr, ONE);
        await attacker.approveTx(id);
        await wallet.connect(alice).approve(id);
      }
      return { wallet, attacker, attackerAddr };
    }

    it("re-running the same proposal from inside its own payment fails (executed is set first)", async function () {
      const { wallet, attacker, attackerAddr } = await loadFixture(deployWithAttacker);
      await attacker.executeTx(0, 0);
      expect(await attacker.attempted()).to.equal(true);
      expect(await attacker.replaySucceeded()).to.equal(false);
      expect(await ethers.provider.getBalance(attackerAddr)).to.equal(ONE);
      expect((await wallet.getTransaction(0)).executed).to.equal(true);
    });

    it("running a second proposal from inside a payment is blocked by the lock", async function () {
      const { wallet, attacker, attackerAddr } = await loadFixture(deployWithAttacker);
      await attacker.executeTx(0, 1);
      expect(await attacker.replaySucceeded()).to.equal(false);
      expect(await ethers.provider.getBalance(attackerAddr)).to.equal(ONE);
      expect((await wallet.getTransaction(1)).executed).to.equal(false);
    });
  });

  describe("security: removed owners and owner changes", function () {
    it("owners can add an owner and raise the threshold through proposals", async function () {
      const { wallet, alice, bob, dave } = await loadFixture(deploy);
      await expect(governed(wallet, [alice, bob], "addOwner", [dave.address]))
        .to.emit(wallet, "OwnerAdded").withArgs(dave.address);
      await governed(wallet, [alice, dave], "changeThreshold", [3]);
      expect(await wallet.getOwners()).to.have.length(4);
      expect(await wallet.threshold()).to.equal(3n);
    });

    it("a removed owner loses all power at once", async function () {
      const { wallet, alice, bob, carol, dave } = await loadFixture(deploy);
      await governed(wallet, [alice, bob], "removeOwner", [carol.address]);
      expect(await wallet.isOwner(carol.address)).to.equal(false);
      expect(await wallet.getOwners()).to.deep.equal([alice.address, bob.address]);
      await expect(wallet.connect(carol).submit(dave.address, ONE, "0x")).to.be.revertedWithCustomError(wallet, "NotOwner");
    });

    it("an approval from a removed owner cannot be used to move money", async function () {
      const { wallet, alice, bob, carol, dave } = await loadFixture(deploy);
      // Carol approves a payment to Dave, then Alice and Bob remove Carol.
      await wallet.connect(carol).submit(dave.address, ONE, "0x");
      await wallet.connect(carol).approve(0);
      await governed(wallet, [alice, bob], "removeOwner", [carol.address]);
      // Without the fix, Alice's single approval + Carol's old one would reach 2.
      await expect(wallet.connect(alice).approve(0)).to.be.revertedWithCustomError(wallet, "StaleTransaction").withArgs(0);
      await expect(wallet.connect(alice).execute(0)).to.be.revertedWithCustomError(wallet, "StaleTransaction");
      expect((await wallet.getTransaction(0)).stale).to.equal(true);
    });

    it("a removed and re-added owner does not get old approvals back", async function () {
      const { wallet, alice, bob, carol, dave } = await loadFixture(deploy);
      await wallet.connect(carol).submit(dave.address, ONE, "0x");
      await wallet.connect(carol).approve(0);
      await governed(wallet, [alice, bob], "removeOwner", [carol.address]);
      await governed(wallet, [alice, bob], "addOwner", [carol.address]);
      await expect(wallet.connect(alice).approve(0)).to.be.revertedWithCustomError(wallet, "StaleTransaction");
    });

    it("lowering the threshold does not unlock proposals approved under the old rules", async function () {
      const { wallet, alice, bob, dave } = await loadFixture(deploy);
      await wallet.connect(alice).submit(dave.address, ONE, "0x");
      await wallet.connect(alice).approve(0);
      await governed(wallet, [alice, bob], "changeThreshold", [1]);
      await expect(wallet.connect(alice).execute(0)).to.be.revertedWithCustomError(wallet, "StaleTransaction");
    });

    it("cannot remove owners below the threshold, a stranger, or set a bad threshold", async function () {
      const { wallet, alice, bob, carol, dave } = await loadFixture(deploy);
      await governed(wallet, [alice, bob], "removeOwner", [carol.address]); // 2 owners, threshold 2
      await expect(governed(wallet, [alice, bob], "removeOwner", [bob.address])).to.be.revertedWithCustomError(wallet, "ExecutionFailed");
      await expect(governed(wallet, [alice, bob], "removeOwner", [dave.address])).to.be.revertedWithCustomError(wallet, "ExecutionFailed");
      await expect(governed(wallet, [alice, bob], "changeThreshold", [0])).to.be.revertedWithCustomError(wallet, "ExecutionFailed");
      await expect(governed(wallet, [alice, bob], "changeThreshold", [3])).to.be.revertedWithCustomError(wallet, "ExecutionFailed");
      await expect(governed(wallet, [alice, bob], "addOwner", [alice.address])).to.be.revertedWithCustomError(wallet, "ExecutionFailed");
      expect(await wallet.getOwners()).to.deep.equal([alice.address, bob.address]);
    });
  });

  describe("limits", function () {
    it("cannot grow past 10 owners", async function () {
      const { signers } = await loadFixture(deploy);
      const ten = signers.slice(0, 10);
      const wallet = await ethers.deployContract("MultiSigWallet", [ten.map((s) => s.address), 2]);
      await expect(governed(wallet, [ten[0], ten[1]], "addOwner", [signers[10].address]))
        .to.be.revertedWithCustomError(wallet, "ExecutionFailed");
      expect(await wallet.getOwners()).to.have.length(10);
    });
  });

  describe("fuzz: random approvals, revokes and executes", function () {
    it("money moves only with 2 current approvals and each proposal pays at most once (50 random runs)", async function () {
      const { wallet, alice, bob, carol, eve } = await loadFixture(deploy);
      const owners = [alice, bob, carol];
      const walletAddr = await wallet.getAddress();
      const startBalance = await ethers.provider.getBalance(walletAddr);
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.record({ op: fc.constantFrom("submit", "approve", "revoke", "execute"), who: fc.nat(3), id: fc.nat(3) }), { minLength: 5, maxLength: 25 }),
          async (steps) => {
            const snap = await ethers.provider.send("evm_snapshot", []);
            const model = []; // { approvals: Set, executed }
            let paid = 0n;
            for (const { op, who, id } of steps) {
              const signer = who === 3 ? eve : owners[who];
              const isOwner = who !== 3;
              const t = model[id];
              let expectOk;
              let tx;
              if (op === "submit") {
                expectOk = isOwner;
                tx = () => wallet.connect(signer).submit(eve.address, ONE, "0x");
              } else if (op === "approve") {
                expectOk = isOwner && !!t && !t.executed && !t.approvals.has(who);
                tx = () => wallet.connect(signer).approve(id);
              } else if (op === "revoke") {
                expectOk = isOwner && !!t && !t.executed && t.approvals.has(who);
                tx = () => wallet.connect(signer).revoke(id);
              } else {
                expectOk = isOwner && !!t && !t.executed && t.approvals.size >= 2;
                tx = () => wallet.connect(signer).execute(id);
              }
              let ok = true;
              try { await (await tx()).wait(); } catch { ok = false; }
              expect(ok).to.equal(expectOk, `${op} by ${who} on ${id}`);
              if (!ok) continue;
              if (op === "submit") model.push({ approvals: new Set(), executed: false });
              if (op === "approve") t.approvals.add(who);
              if (op === "revoke") t.approvals.delete(who);
              if (op === "execute") { t.executed = true; paid += ONE; }
            }
            // Invariants: balance only drops by executed payments; counts match the model.
            expect(await ethers.provider.getBalance(walletAddr)).to.equal(startBalance - paid);
            for (let i = 0; i < model.length; i++) {
              const onChain = await wallet.getTransaction(i);
              expect(onChain.approvals).to.equal(BigInt(model[i].approvals.size));
              expect(onChain.executed).to.equal(model[i].executed);
            }
            await ethers.provider.send("evm_revert", [snap]);
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});
