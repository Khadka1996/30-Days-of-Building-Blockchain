const { expect } = require("chai");
const hre = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const fc = require("fast-check");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");
const kit = require("../lib/deployKit");

const { ethers } = hre;
const quiet = () => {};

describe("Day 07 — Week 1 deploy kit", function () {
  let signers, deployer, a, b, c, owners, outDir;

  beforeEach(async function () {
    signers = await ethers.getSigners();
    [deployer, a, b, c] = signers;
    owners = [a.address, b.address, c.address];
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "day07-test-"));
  });
  afterEach(() => fs.rmSync(outDir, { recursive: true, force: true }));

  const deploy = (extra = {}) => kit.deployAll(hre, { owners, threshold: 2, outDir, log: quiet, ...extra });

  describe("network and key checks", function () {
    it("allows only the local chain and Sepolia, refuses mainnet and others", function () {
      expect(kit.assertSafeNetwork(31337)).to.match(/hardhat/);
      expect(kit.assertSafeNetwork(11155111n)).to.match(/sepolia/);
      for (const id of [1, 10, 137, 8453, 42161, 5, 17000]) {
        expect(() => kit.assertSafeNetwork(id)).to.throw(kit.DeployError, /Refusing/);
      }
    });

    it("accepts a 0x + 64 hex private key and rejects anything else without printing it", function () {
      const good = ethers.Wallet.createRandom().privateKey;
      expect(() => kit.assertPrivateKeyFormat(good)).not.to.throw();
      for (const bad of [undefined, "", good.slice(2), good.slice(0, 40), good + "00", "0x" + "z".repeat(64), "0x" + "0".repeat(64)]) {
        let msg = "";
        try { kit.assertPrivateKeyFormat(bad); } catch (e) { msg = e.message; }
        expect(msg, `should reject ${String(bad).slice(0, 10)}`).to.not.equal("");
        if (bad) expect(msg).to.not.include(String(bad).slice(4, 20));
      }
    });

    it("hardhat.config refuses to load with a malformed PRIVATE_KEY", function () {
      const run = () => execSync("npx hardhat --config hardhat.config.js compile --quiet", {
        cwd: path.join(__dirname, ".."), stdio: "pipe",
        env: { ...process.env, SEPOLIA_RPC_URL: "http://127.0.0.1:1", PRIVATE_KEY: "0x1234" },
      });
      expect(run).to.throw(/PRIVATE_KEY must be 0x followed by 64 hex/);
    });

    it("hardhat.config refuses half a Sepolia setup (RPC URL without key, or key without URL)", function () {
      const key = ethers.Wallet.createRandom().privateKey;
      for (const env of [{ SEPOLIA_RPC_URL: "http://127.0.0.1:1", PRIVATE_KEY: "" }, { SEPOLIA_RPC_URL: "", PRIVATE_KEY: key }]) {
        const run = () => execSync("npx hardhat compile --quiet", { cwd: path.join(__dirname, ".."), stdio: "pipe", env: { ...process.env, ...env } });
        expect(run).to.throw(/Set BOTH SEPOLIA_RPC_URL and PRIVATE_KEY/);
      }
    });
  });

  describe("multisig settings are checked before any gas is spent", function () {
    it("parses a comma list into checksummed addresses and rejects junk", function () {
      const parsed = kit.parseOwners(` ${a.address.toLowerCase()}, ${b.address} ,`, ethers);
      expect(parsed).to.deep.equal([a.address, b.address]);
      expect(kit.parseOwners("", ethers)).to.deep.equal([]);
      expect(() => kit.parseOwners("0xOwnerOne,0xOwnerTwo", ethers)).to.throw(/not a valid address/);
    });

    it("rejects empty, too many, zero, duplicate (any letter case) owners and bad thresholds", function () {
      const v = (o, t) => () => kit.validateMultisig(o, t, ethers);
      expect(v([], 1)).to.throw(/1 to 10 owners/);
      expect(v(signers.slice(0, 11).map((s) => s.address), 2)).to.throw(/1 to 10 owners/);
      expect(v([a.address, ethers.ZeroAddress], 1)).to.throw(/zero address/);
      expect(v([a.address, a.address.toLowerCase()], 1)).to.throw(/listed twice/);
      for (const t of [0, 4, -1, 1.5, "two", undefined]) expect(v(owners, t)).to.throw(/Threshold/);
      expect(kit.validateMultisig(owners, "2", ethers)).to.deep.equal({ owners, threshold: 2 });
    });

    it("a bad setting stops the run with zero transactions sent", async function () {
      const nonce = await ethers.provider.getTransactionCount(deployer.address);
      await expect(deploy({ owners: [a.address, a.address] })).to.be.rejectedWith(kit.DeployError);
      await expect(deploy({ threshold: 4 })).to.be.rejectedWith(kit.DeployError);
      expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(nonce);
      expect(fs.existsSync(kit.recordPath(outDir, "hardhat"))).to.equal(false);
    });

    it("fuzz: the JavaScript check agrees with the on-chain constructor (40 random settings)", async function () {
      this.timeout(120000);
      const factory = await ethers.getContractFactory("MultiSigWallet");
      const pool = [...signers.slice(0, 12).map((s) => s.address), ethers.ZeroAddress];
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.integer({ min: 0, max: pool.length - 1 }), { minLength: 0, maxLength: 12 }),
          fc.integer({ min: 0, max: 12 }),
          async (idx, threshold) => {
            const list = idx.map((i) => pool[i]);
            let jsOk = true;
            try { kit.validateMultisig(list, threshold, ethers); } catch { jsOk = false; }
            let chainOk = true;
            try { await (await factory.deploy(list, threshold)).waitForDeployment(); } catch { chainOk = false; }
            expect(jsOk, `owners=${idx} threshold=${threshold}`).to.equal(chainOk);
          }
        ),
        { numRuns: 40 }
      );
    });
  });

  describe("deploying", function () {
    it("deploys all six contracts and records address, tx, block, gas and args", async function () {
      const { record, file } = await deploy();
      expect(Object.keys(record.contracts)).to.deep.equal(kit.CONTRACTS.map((x) => x.name));
      for (const x of Object.values(record.contracts)) {
        expect(await ethers.provider.getCode(x.address)).to.not.equal("0x");
        expect(x.txHash).to.match(/^0x[0-9a-f]{64}$/);
        expect(Number(x.gasUsed)).to.be.greaterThan(0);
      }
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(saved.contracts.MultiSigWallet.args).to.deep.equal([owners, 2]);
      expect(saved.deployer).to.equal(deployer.address);
      expect(saved.finishedAt).to.be.a("string");
      expect(JSON.stringify(saved)).to.not.match(/private/i);
    });

    it("the multisig is owned by the chosen owners, not by the deployer", async function () {
      const { record } = await deploy();
      const wallet = await ethers.getContractAt("MultiSigWallet", record.contracts.MultiSigWallet.address);
      expect(await wallet.getOwners()).to.deep.equal(owners);
      expect(await wallet.threshold()).to.equal(2n);
      expect(await wallet.isOwner(deployer.address)).to.equal(false);
    });

    it("refuses to start when the wallet cannot pay for the whole run, sending nothing", async function () {
      const poor = ethers.Wallet.createRandom().connect(ethers.provider);
      await deployer.sendTransaction({ to: poor.address, value: ethers.parseEther("0.0001") });
      await expect(deploy({ signer: poor })).to.be.rejectedWith(/Not enough ETH.*Nothing was sent/);
      expect(await ethers.provider.getTransactionCount(poor.address)).to.equal(0);
    });

    it("a second run resumes: already-deployed contracts are skipped, not paid for again", async function () {
      const first = (await deploy()).record;
      const nonce = await ethers.provider.getTransactionCount(deployer.address);
      const second = (await deploy()).record;
      expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(nonce);
      expect(second.contracts).to.deep.equal(first.contracts);
    });

    it("a run that stopped half-way deploys only the missing contracts", async function () {
      const { record, file } = await deploy();
      const kept = { ...record, contracts: { TodoList: record.contracts.TodoList, PiggyBank: record.contracts.PiggyBank } };
      delete kept.finishedAt;
      kit.saveRecord(file, kept);
      const nonce = await ethers.provider.getTransactionCount(deployer.address);
      const resumed = (await deploy()).record;
      expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(nonce + 4);
      expect(resumed.contracts.TodoList.address).to.equal(record.contracts.TodoList.address);
      expect(resumed.contracts.Voting.address).to.not.equal(record.contracts.Voting.address);
    });

    it("an address in the record with no code (a fresh chain) is deployed again, not trusted", async function () {
      const { record, file } = await deploy();
      record.contracts.Escrow.address = ethers.Wallet.createRandom().address;
      kit.saveRecord(file, record);
      const resumed = (await deploy()).record;
      expect(await ethers.provider.getCode(resumed.contracts.Escrow.address)).to.not.equal("0x");
    });

    it("refuses to resume with different multisig settings instead of mixing two setups", async function () {
      await deploy();
      await expect(deploy({ owners: [a.address, b.address] })).to.be.rejectedWith(/different settings/);
      await expect(deploy({ threshold: 3 })).to.be.rejectedWith(/different settings/);
    });
  });

  describe("verification and post-deploy check", function () {
    it("builds one Etherscan job per contract with the exact saved constructor args", async function () {
      const { record } = await deploy();
      const jobs = kit.verifyJobs(record);
      expect(jobs).to.have.length(6);
      expect(jobs.find((j) => j.name === "MultiSigWallet").constructorArguments).to.deep.equal([owners, 2]);
      expect(jobs.every((j) => j.contract === `contracts/${j.name}.sol:${j.name}`)).to.equal(true);
      const cmds = kit.verifyCommands({ ...record, network: "sepolia" }, () => "args.js");
      expect(cmds.filter((x) => x.includes("--constructor-args args.js"))).to.have.length(1);
      expect(cmds.every((x) => x.startsWith("npx hardhat verify --network sepolia 0x") || x.includes("--constructor-args"))).to.equal(true);
    });

    it("the check passes on a good deploy and catches missing code and wrong multisig settings", async function () {
      const { record } = await deploy();
      expect(await kit.checkDeployment(hre, record)).to.deep.equal([]);
      const wrongOwners = JSON.parse(JSON.stringify(record));
      wrongOwners.contracts.MultiSigWallet.args = [[a.address, b.address, signers[5].address], 2];
      expect(await kit.checkDeployment(hre, wrongOwners)).to.deep.equal(["MultiSigWallet: owners on-chain differ from the record"]);
      const noCode = JSON.parse(JSON.stringify(record));
      noCode.contracts.Voting.address = ethers.Wallet.createRandom().address;
      expect((await kit.checkDeployment(hre, noCode))[0]).to.match(/Voting: no code/);
      expect(await kit.checkDeployment(hre, { ...record, chainId: 11155111 })).to.include("record is for chain 11155111, connected to 31337");
    });
  });

  describe("secrets never reach git", function () {
    const root = path.join(__dirname, "..");
    it(".env is ignored by git and .env.example holds no key", function () {
      const ignored = execSync("git check-ignore .env deployments/hardhat.json deployments/hardhat.MultiSigWallet.args.js", { cwd: root }).toString();
      expect(ignored).to.include(".env").and.to.include("deployments/hardhat.json").and.to.include("hardhat.MultiSigWallet.args.js");
      const example = fs.readFileSync(path.join(root, ".env.example"), "utf8");
      expect(example).to.not.match(/[0-9a-fA-F]{64}/);
      expect(example).to.match(/^PRIVATE_KEY=$/m);
    });

    it("no file in day-07 tracked by git contains something that looks like a private key", function () {
      const files = execSync("git ls-files --cached --others --exclude-standard", { cwd: root }).toString().split("\n").filter(Boolean);
      for (const f of files) {
        if (f.endsWith(".png") || f.includes("package-lock")) continue;
        const text = fs.readFileSync(path.join(root, f), "utf8");
        expect(/PRIVATE_KEY\s*=\s*0x[0-9a-fA-F]{64}/.test(text), f).to.equal(false);
      }
    });
  });

  describe("week tour: the deployed contracts really work", function () {
    it("deploys exactly the reviewed code: every contract is byte-identical to its Day 01–06 original", function () {
      const files = { TodoList: ["01"], PiggyBank: ["02"], IPiggyBank: ["02"], Voting: ["03"], MultiSigWallet: ["04"], Escrow: ["05"], CrowdFund: ["06"] };
      for (const [name, [day]] of Object.entries(files)) {
        const here = fs.readFileSync(path.join(__dirname, "..", "contracts", `${name}.sol`));
        const original = fs.readFileSync(path.join(__dirname, "..", "..", `day-${day}`, "contracts", `${name}.sol`));
        expect(here.equals(original), `${name}.sol differs from day-${day}`).to.equal(true);
      }
    });

    it("each of the six Week 1 contracts does its main job", async function () {
      const { record } = await deploy();
      const at = (n) => ethers.getContractAt(n, record.contracts[n].address);
      const [todo, piggy, voting, wallet, escrow, fund] = await Promise.all(kit.CONTRACTS.map((x) => at(x.name)));
      const one = ethers.parseEther("1");

      await todo.connect(a).addTask("Deploy Week 1 to Sepolia");
      expect(await todo.taskCount(a.address)).to.equal(1n);

      const unlock = (await time.latest()) + 3600;
      await piggy.connect(a).deposit(unlock, { value: one });
      await time.increaseTo(unlock);
      await expect(piggy.connect(a).withdraw()).to.changeEtherBalance(a, one);

      await voting.connect(a).createPoll("Ship it?", ["Yes", "No"], (await time.latest()) + 600);
      await voting.connect(b).vote(1, 0);
      expect(await voting.hasVoted(1, b.address)).to.equal(true);

      await deployer.sendTransaction({ to: await wallet.getAddress(), value: one });
      await wallet.connect(a).submit(c.address, one, "0x");
      await wallet.connect(a).approve(0);
      await wallet.connect(b).approve(0);
      await expect(wallet.connect(a).execute(0)).to.changeEtherBalance(c, one);

      await escrow.connect(a).openDeal(b.address, c.address, 86400, { value: one });
      await escrow.connect(a).confirmDelivery(0);
      await expect(escrow.connect(b).withdraw()).to.changeEtherBalance(b, one);

      await fund.connect(a).launch(one, 3600);
      await fund.connect(b).pledge(0, { value: one });
      await time.increase(3600);
      await expect(fund.connect(a).claim(0)).to.changeEtherBalance(a, one);
    });
  });
});
