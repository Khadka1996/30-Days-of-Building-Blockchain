const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { tagged, E, State, Vote, baseFixture, grantProposal, propose, toVoting, endVoting, mine, time } = require("./helpers");

describe("HimalDAO", function () {
  describe("deployment", function () {
    it("uses the planned settings", async function () {
      const { dao, token, timelock } = await loadFixture(baseFixture);
      expect(await dao.name()).to.equal("Himal DAO");
      expect(await dao.votingDelay()).to.equal(7200n);
      expect(await dao.votingPeriod()).to.equal(50400n);
      expect(await dao.proposalThreshold()).to.equal(E(10000));
      expect(await dao["quorumNumerator()"]()).to.equal(4n);
      expect(await timelock.getMinDelay()).to.equal(2n * 24n * 3600n);
      expect(await dao.timelock()).to.equal(await timelock.getAddress());
      expect(await token.totalSupply()).to.equal(E(1000000));
    });

    it("the deployer keeps no power over the treasury (admin renounced)", async function () {
      const { timelock, deployer } = await loadFixture(baseFixture);
      for (const role of ["DEFAULT_ADMIN_ROLE", "PROPOSER_ROLE", "CANCELLER_ROLE"]) {
        expect(await timelock.hasRole(await timelock[role](), deployer.address)).to.equal(false);
      }
      // the timelock administers itself, so roles change only through a passed proposal
      expect(await timelock.hasRole(await timelock.DEFAULT_ADMIN_ROLE(), await timelock.getAddress())).to.equal(true);
    });

    it("only the DAO can queue and cancel; anyone can execute", async function () {
      const { timelock, dao } = await loadFixture(baseFixture);
      const daoAddr = await dao.getAddress();
      expect(await timelock.hasRole(await timelock.PROPOSER_ROLE(), daoAddr)).to.equal(true);
      expect(await timelock.hasRole(await timelock.CANCELLER_ROLE(), daoAddr)).to.equal(true);
      expect(await timelock.hasRole(await timelock.EXECUTOR_ROLE(), ethers.ZeroAddress)).to.equal(true);
    });

    it("nobody can bypass the vote to reach the treasury or the fund", async function () {
      const { timelock, fund, deployer, ram } = await loadFixture(baseFixture);
      await expect(
        timelock.connect(deployer).schedule(ram.address, E(20), "0x", ethers.ZeroHash, ethers.ZeroHash, 172800)
      ).to.be.revertedWithCustomError(timelock, "AccessControlUnauthorizedAccount");
      await expect(
        timelock.connect(deployer).grantRole(await timelock.PROPOSER_ROLE(), deployer.address)
      ).to.be.revertedWithCustomError(timelock, "AccessControlUnauthorizedAccount");
      await expect(fund.connect(ram).approveProject("x", ram.address, 1)).to.be.revertedWithCustomError(
        fund,
        "OwnableUnauthorizedAccount"
      );
    });

    it("rejects ETH sent to the Governor by mistake (it would be stuck)", async function () {
      const { dao, ram } = await loadFixture(baseFixture);
      await expect(ram.sendTransaction({ to: await dao.getAddress(), value: E(1) })).to.be.revertedWithCustomError(
        dao,
        "GovernorDisabledDeposit"
      );
    });

    it("settings can only be changed by a passed proposal", async function () {
      const { dao, ram } = await loadFixture(baseFixture);
      await expect(dao.connect(ram).setProposalThreshold(0)).to.be.revertedWithCustomError(dao, "GovernorOnlyExecutor");
      await expect(dao.connect(ram).updateQuorumNumerator(1)).to.be.revertedWithCustomError(dao, "GovernorOnlyExecutor");
    });
  });

  describe("voting power", function () {
    it("tokens give no votes until the holder delegates", async function () {
      const { token, deployer, hari, friend } = await loadFixture(baseFixture);
      await token.connect(hari).transfer(friend.address, E(50000));
      expect(await token.getVotes(friend.address)).to.equal(0n);
      await token.connect(friend).delegate(friend.address);
      expect(await token.getVotes(friend.address)).to.equal(E(50000));
      expect(await token.getVotes(deployer.address)).to.equal(0n);
    });

    it("a holder can lend their votes to someone they trust", async function () {
      const { token, gita, sita } = await loadFixture(baseFixture);
      await token.connect(gita).delegate(sita.address);
      expect(await token.getVotes(sita.address)).to.equal(E(125000));
      expect(await token.getVotes(gita.address)).to.equal(0n);
    });
  });

  describe("proposal lifecycle", function () {
    it("propose → vote → queue → wait 2 days → execute pays the grant", async function () {
      const f = await loadFixture(baseFixture);
      const { dao, timelock, fund, ram, sita, hari, attacker, school } = f;
      const p = await grantProposal(f, school.address, ram);
      await expect(dao.connect(ram).propose(p.targets, p.values, p.calldatas, p.description)).to.emit(
        dao,
        "ProposalCreated"
      );
      expect(await dao.state(p.id)).to.equal(State.Pending);

      // voting has not started yet
      await expect(dao.connect(sita).castVote(p.id, Vote.For)).to.be.revertedWithCustomError(
        dao,
        "GovernorUnexpectedProposalState"
      );

      await toVoting(f);
      expect(await dao.state(p.id)).to.equal(State.Active);
      await expect(dao.connect(ram).castVote(p.id, Vote.For))
        .to.emit(dao, "VoteCast")
        .withArgs(ram.address, p.id, Vote.For, E(200000), "");
      await dao.connect(sita).castVoteWithReason(p.id, Vote.Against, "Too much for one school");
      await dao.connect(hari).castVote(p.id, Vote.For);

      const [against, forVotes, abstain] = await dao.proposalVotes(p.id);
      expect([against, forVotes, abstain]).to.deep.equal([E(120000), E(275000), 0n]);

      // cannot queue while voting is open
      await expect(dao.queue(p.targets, p.values, p.calldatas, p.descriptionHash)).to.be.revertedWithCustomError(
        dao,
        "GovernorUnexpectedProposalState"
      );
      await endVoting(f);
      expect(await dao.state(p.id)).to.equal(State.Succeeded);

      // must be queued first: the timelock has no such operation yet
      await expect(dao.execute(p.targets, p.values, p.calldatas, p.descriptionHash)).to.be.revertedWithCustomError(
        timelock,
        "TimelockUnexpectedOperationState"
      );
      await dao.queue(p.targets, p.values, p.calldatas, p.descriptionHash);
      expect(await dao.state(p.id)).to.equal(State.Queued);

      // the 2-day wait is enforced by the timelock
      await time.increase(2 * 24 * 3600 - 60);
      await expect(
        dao.execute(p.targets, p.values, p.calldatas, p.descriptionHash)
      ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");

      await time.increase(120);
      // anyone can press "execute" once the wait is over
      await expect(
        dao.connect(attacker).execute(p.targets, p.values, p.calldatas, p.descriptionHash)
      ).to.changeEtherBalances([timelock, school], [E(-5), E(5)]);
      expect(await dao.state(p.id)).to.equal(State.Executed);
      expect(await fund.projectCount()).to.equal(1n);
      const project = await fund.projects(0);
      expect(project.recipient).to.equal(school.address);

      // and it cannot run twice
      await expect(dao.execute(p.targets, p.values, p.calldatas, p.descriptionHash)).to.be.revertedWithCustomError(
        dao,
        "GovernorUnexpectedProposalState"
      );
    });

    it("is defeated when Against beats For", async function () {
      const f = await loadFixture(baseFixture);
      const p = await grantProposal(f, f.school.address, f.ram);
      await propose(f, f.ram, p);
      await toVoting(f);
      await f.dao.connect(f.ram).castVote(p.id, Vote.Against);
      await f.dao.connect(f.sita).castVote(p.id, Vote.For);
      await endVoting(f);
      expect(await f.dao.state(p.id)).to.equal(State.Defeated);
      await expect(
        f.dao.queue(p.targets, p.values, p.calldatas, p.descriptionHash)
      ).to.be.revertedWithCustomError(f.dao, "GovernorUnexpectedProposalState");
    });

    it("a tie is not a win", async function () {
      const f = await loadFixture(baseFixture);
      await f.token.connect(f.sita).transfer(f.friend.address, E(20000)); // Sita 100k
      await f.token.connect(f.ram).transfer(f.friend.address, E(100000)); // Ram 100k
      await mine(1);
      const p = await grantProposal(f, f.school.address, f.ram);
      await propose(f, f.ram, p);
      await toVoting(f);
      await f.dao.connect(f.ram).castVote(p.id, Vote.For);
      await f.dao.connect(f.sita).castVote(p.id, Vote.Against);
      await endVoting(f);
      expect(await f.dao.state(p.id)).to.equal(State.Defeated);
    });

    it("is defeated when too few people vote (quorum 4% = 40,000 HVT)", async function () {
      const f = await loadFixture(baseFixture);
      const p = await grantProposal(f, f.school.address, f.hari);
      await propose(f, f.hari, p);
      await toVoting(f);
      await f.dao.connect(f.gita).castVote(p.id, Vote.For); // 5,000 HVT only
      await endVoting(f);
      const snapshot = await f.dao.proposalSnapshot(p.id);
      expect(await f.dao.quorum(snapshot)).to.equal(E(40000));
      expect(await f.dao.state(p.id)).to.equal(State.Defeated);
    });

    it("Abstain counts toward quorum but not toward winning", async function () {
      const f = await loadFixture(baseFixture);
      const p = await grantProposal(f, f.school.address, f.hari);
      await propose(f, f.hari, p);
      await toVoting(f);
      await f.dao.connect(f.gita).castVote(p.id, Vote.For); // 5k For
      await f.dao.connect(f.hari).castVote(p.id, Vote.Abstain); // 75k Abstain -> quorum reached
      await endVoting(f);
      expect(await f.dao.state(p.id)).to.equal(State.Succeeded);
    });

    it("nobody can vote after voting has ended", async function () {
      const f = await loadFixture(baseFixture);
      const p = await grantProposal(f, f.school.address, f.ram);
      await propose(f, f.ram, p);
      await toVoting(f);
      await endVoting(f);
      await expect(f.dao.connect(f.sita).castVote(p.id, Vote.For)).to.be.revertedWithCustomError(
        f.dao,
        "GovernorUnexpectedProposalState"
      );
    });

    it("the proposer can cancel only before voting starts", async function () {
      const f = await loadFixture(baseFixture);
      const p = await grantProposal(f, f.school.address, f.ram);
      await propose(f, f.ram, p);
      await expect(
        f.dao.connect(f.sita).cancel(p.targets, p.values, p.calldatas, p.descriptionHash)
      ).to.be.revertedWithCustomError(f.dao, "GovernorOnlyProposer");
      await f.dao.connect(f.ram).cancel(p.targets, p.values, p.calldatas, p.descriptionHash);
      expect(await f.dao.state(p.id)).to.equal(State.Canceled);

      const p2 = await grantProposal(f, f.school.address, f.ram, E(1), "Second try");
      await propose(f, f.ram, p2);
      await toVoting(f);
      await expect(
        f.dao.connect(f.ram).cancel(p2.targets, p2.values, p2.calldatas, p2.descriptionHash)
      ).to.be.revertedWithCustomError(f.dao, "GovernorUnexpectedProposalState");
    });

    it("a proposal that asks for more than the treasury holds fails safely at execution", async function () {
      const f = await loadFixture(baseFixture);
      const p = await grantProposal(f, f.school.address, f.ram, E(500), "Grant: 500 ETH");
      await propose(f, f.ram, p);
      await toVoting(f);
      await f.dao.connect(f.ram).castVote(p.id, Vote.For);
      await endVoting(f);
      await f.dao.queue(p.targets, p.values, p.calldatas, p.descriptionHash);
      await time.increase(2 * 24 * 3600 + 1);
      await expect(f.dao.execute(p.targets, p.values, p.calldatas, p.descriptionHash)).to.be.reverted;
      expect(await ethers.provider.getBalance(await f.timelock.getAddress())).to.equal(E(20));
    });
  });

  describe("attack: double voting", function () {
    it("one address cannot vote twice", async function () {
      const f = await loadFixture(baseFixture);
      const p = await grantProposal(f, f.school.address, f.ram);
      await propose(f, f.ram, p);
      await toVoting(f);
      await f.dao.connect(f.ram).castVote(p.id, Vote.For);
      await expect(f.dao.connect(f.ram).castVote(p.id, Vote.Against)).to.be.revertedWithCustomError(
        f.dao,
        "GovernorAlreadyCastVote"
      );
    });

    it("vote, pass the tokens to a friend, vote again: the friend's vote weighs 0", async function () {
      const f = await loadFixture(baseFixture);
      const p = await grantProposal(f, f.school.address, f.ram);
      await propose(f, f.ram, p);
      await toVoting(f);
      await f.dao.connect(f.ram).castVote(p.id, Vote.For);
      await f.token.connect(f.ram).transfer(f.friend.address, E(200000));
      await f.token.connect(f.friend).delegate(f.friend.address);
      await f.dao.connect(f.friend).castVote(p.id, Vote.For);
      const [, forVotes] = await f.dao.proposalVotes(p.id);
      expect(forVotes).to.equal(E(200000));
    });

    it("the snapshot is taken when voting starts: tokens bought after that do not count", async function () {
      const f = await loadFixture(baseFixture);
      const p = await grantProposal(f, f.school.address, f.ram);
      await propose(f, f.ram, p);
      await toVoting(f);
      await f.token.connect(f.sita).transfer(f.gita.address, E(100000)); // voting already open
      await f.dao.connect(f.gita).castVote(p.id, Vote.For);
      const [, forVotes] = await f.dao.proposalVotes(p.id);
      expect(forVotes).to.equal(E(5000)); // her votes at the snapshot
    });

    it("documented: tokens moved during the 1-day delay DO count (the delay is for people to get ready)", async function () {
      const f = await loadFixture(baseFixture);
      const p = await grantProposal(f, f.school.address, f.ram);
      await propose(f, f.ram, p);
      expect(await f.dao.proposalSnapshot(p.id)).to.equal(BigInt(await ethers.provider.getBlockNumber()) + 7200n);
      await f.token.connect(f.sita).transfer(f.gita.address, E(100000)); // during the delay
      await toVoting(f);
      await f.dao.connect(f.gita).castVote(p.id, Vote.For);
      const [, forVotes] = await f.dao.proposalVotes(p.id);
      expect(forVotes).to.equal(E(105000));
    });
  });

  describe("attack: flash-loan voting", function () {
    it("NAIVE DAO: a flash loan of 600,000 tokens drains its treasury in one transaction", async function () {
      const f = await loadFixture(baseFixture);
      const naive = await ethers.deployContract("NaiveDAO", [await f.token.getAddress()]);
      await f.deployer.sendTransaction({ to: await naive.getAddress(), value: E(10) });
      const voter = await ethers
        .getContractFactory("FlashVoter", f.attacker)
        .then((cf) => cf.deploy(f.token.getAddress(), f.lender.getAddress()));
      await expect(voter.connect(f.attacker).attackNaive(await naive.getAddress(), E(600000))).to.changeEtherBalances(
        [naive, f.attacker],
        [E(-10), E(10)]
      );
      // the loan was repaid: the attacker never owned a single token
      expect(await f.token.balanceOf(await f.lender.getAddress())).to.equal(E(600000));
    });

    it("HIMAL DAO: the same flash loan gives 0 votes on an open proposal", async function () {
      const f = await loadFixture(baseFixture);
      const p = await grantProposal(f, f.school.address, f.ram);
      await propose(f, f.ram, p);
      await toVoting(f);
      const voter = await ethers
        .getContractFactory("FlashVoter", f.attacker)
        .then((cf) => cf.deploy(f.token.getAddress(), f.lender.getAddress()));
      await voter.attackVote(await f.dao.getAddress(), p.id, E(600000));
      expect(await voter.weightUsed()).to.equal(0n);
      const [against, forVotes] = await f.dao.proposalVotes(p.id);
      expect(against + forVotes).to.equal(0n);
    });

    it("HIMAL DAO: a flash loan cannot meet the proposal threshold either", async function () {
      const f = await loadFixture(baseFixture);
      const voter = await ethers
        .getContractFactory("FlashVoter", f.attacker)
        .then((cf) => cf.deploy(f.token.getAddress(), f.lender.getAddress()));
      await voter.attackPropose(await f.dao.getAddress(), E(600000));
      expect(await voter.proposeSucceeded()).to.equal(false);
      const err = f.dao.interface.parseError(await voter.proposeError());
      expect(err.name).to.equal("GovernorInsufficientProposerVotes");
      expect(err.args[1]).to.equal(0n); // its votes one block ago
    });

    it("the votes a flash borrower held for one block are gone afterwards", async function () {
      const f = await loadFixture(baseFixture);
      const voter = await ethers
        .getContractFactory("FlashVoter", f.attacker)
        .then((cf) => cf.deploy(f.token.getAddress(), f.lender.getAddress()));
      await voter.attackPropose(await f.dao.getAddress(), E(600000));
      const block = await ethers.provider.getBlockNumber();
      await mine(1);
      expect(await f.token.getPastVotes(await voter.getAddress(), block)).to.equal(0n);
    });
  });

  describe("attack: proposal spam", function () {
    it("a small holder (5,000 HVT) cannot create proposals", async function () {
      const f = await loadFixture(baseFixture);
      const p = await grantProposal(f, f.school.address, f.gita);
      await expect(f.dao.connect(f.gita).propose(p.targets, p.values, p.calldatas, p.description))
        .to.be.revertedWithCustomError(f.dao, "GovernorInsufficientProposerVotes")
        .withArgs(f.gita.address, E(5000), E(10000));
    });

    it("the threshold edge: 1 wei below 10,000 HVT fails, exactly 10,000 works", async function () {
      const f = await loadFixture(baseFixture);
      await f.token.connect(f.hari).transfer(f.friend.address, E(10000) - 1n);
      await f.token.connect(f.friend).delegate(f.friend.address);
      await mine(1);
      const p = await grantProposal(f, f.school.address, f.friend);
      await expect(
        f.dao.connect(f.friend).propose(p.targets, p.values, p.calldatas, p.description)
      ).to.be.revertedWithCustomError(f.dao, "GovernorInsufficientProposerVotes");
      await f.token.connect(f.hari).transfer(f.friend.address, 1n);
      await mine(1);
      await expect(f.dao.connect(f.friend).propose(p.targets, p.values, p.calldatas, p.description)).to.emit(
        f.dao,
        "ProposalCreated"
      );
    });

    it("the same proposal cannot be submitted twice", async function () {
      const f = await loadFixture(baseFixture);
      const p = await grantProposal(f, f.school.address, f.ram);
      await propose(f, f.ram, p);
      await expect(
        f.dao.connect(f.ram).propose(p.targets, p.values, p.calldatas, p.description)
      ).to.be.revertedWithCustomError(f.dao, "GovernorUnexpectedProposalState");
    });
  });

  describe("attack: copying someone else's proposal (front-running)", function () {
    it("OPTIONAL TAG (OpenZeppelin default): Hari copies Ram's waiting proposal, cancels it, and Ram can never make it", async function () {
      const f = await loadFixture(baseFixture);
      const stock = await ethers.deployContract("OptionalTagDAO", [await f.token.getAddress(), await f.timelock.getAddress()]);
      const p = await grantProposal(f, f.school.address, f.ram);
      const plain = "Grant: 5 ETH for the Bhaktapur school library"; // no tag
      // Hari saw Ram's transaction waiting and sent the same one first
      await stock.connect(f.hari).propose(p.targets, p.values, p.calldatas, plain);
      await stock.connect(f.hari).cancel(p.targets, p.values, p.calldatas, ethers.id(plain));
      await expect(
        stock.connect(f.ram).propose(p.targets, p.values, p.calldatas, plain)
      ).to.be.revertedWithCustomError(stock, "GovernorUnexpectedProposalState");
    });

    it("HIMAL DAO: a description without the '#proposer=' tag is rejected", async function () {
      const f = await loadFixture(baseFixture);
      const p = await grantProposal(f, f.school.address, f.ram);
      await expect(f.dao.connect(f.ram).propose(p.targets, p.values, p.calldatas, "Grant: 5 ETH"))
        .to.be.revertedWithCustomError(f.dao, "GovernorRestrictedProposer")
        .withArgs(f.ram.address);
    });

    it("HIMAL DAO: Hari cannot submit Ram's tagged proposal first; Ram's still goes through", async function () {
      const f = await loadFixture(baseFixture);
      const p = await grantProposal(f, f.school.address, f.ram);
      await expect(
        f.dao.connect(f.hari).propose(p.targets, p.values, p.calldatas, p.description)
      ).to.be.revertedWithCustomError(f.dao, "GovernorRestrictedProposer");
      await expect(f.dao.connect(f.ram).propose(p.targets, p.values, p.calldatas, p.description)).to.emit(
        f.dao,
        "ProposalCreated"
      );
    });

    it("HIMAL DAO: tags the default rule would silently ignore are rejected too", async function () {
      const f = await loadFixture(baseFixture);
      const p = await grantProposal(f, f.school.address, f.ram);
      const base = "Grant: 5 ETH";
      const bad = [
        `${base}#proposer=${f.ram.address}`, // checksummed (mixed case)
        `${base}#proposer=${f.ram.address.toLowerCase()} `, // trailing space
        `${base}#proposer=0x${"z".repeat(40)}`, // not hex
        `${base}#other=${f.ram.address.toLowerCase()}`, // wrong key
      ];
      for (const d of bad) {
        await expect(f.dao.connect(f.ram).propose(p.targets, p.values, p.calldatas, d)).to.be.revertedWithCustomError(
          f.dao,
          "GovernorRestrictedProposer"
        );
      }
    });
  });

  describe("the DAO can change its own rules", function () {
    it("a passed proposal raises the proposal threshold", async function () {
      const f = await loadFixture(baseFixture);
      const targets = [await f.dao.getAddress()];
      const values = [0n];
      const calldatas = [f.dao.interface.encodeFunctionData("setProposalThreshold", [E(20000)])];
      const description = tagged("Raise the proposal threshold to 20,000 HVT", f.ram);
      await f.dao.connect(f.ram).propose(targets, values, calldatas, description);
      await toVoting(f);
      await f.dao.connect(f.ram).castVote(await f.dao.hashProposal(targets, values, calldatas, ethers.id(description)), Vote.For);
      await endVoting(f);
      await f.dao.queue(targets, values, calldatas, ethers.id(description));
      await time.increase(2 * 24 * 3600 + 1);
      await f.dao.execute(targets, values, calldatas, ethers.id(description));
      expect(await f.dao.proposalThreshold()).to.equal(E(20000));
    });
  });
});
