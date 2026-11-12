const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, setBalance } = require("@nomicfoundation/hardhat-network-helpers");
const fc = require("fast-check");
const { buildAllowlist } = require("../lib/allowlist");

const ETH = (n) => ethers.parseEther(String(n));
const AL_PRICE = ETH("0.01");
const PUB_PRICE = ETH("0.02");
const MAX = 20;
const RESERVE = 4;
const BASE = "ipfs://bafy-himal-peaks/";
const Phase = { Closed: 0, Allowlist: 1, Public: 2 };

async function deployWith({ max = MAX, reserve = RESERVE, alPrice = AL_PRICE, pubPrice = PUB_PRICE } = {}) {
  const [owner, treasury, ...users] = await ethers.getSigners();
  const listed = users.slice(0, 6);
  const al = buildAllowlist(listed.map((s) => s.address));
  const nft = await ethers.deployContract("HimalPeaks", [owner.address, treasury.address, max, reserve, alPrice, pubPrice, al.root, BASE]);
  return { owner, treasury, users, listed, outsider: users[10], al, nft, addr: await nft.getAddress() };
}
const deploy = () => deployWith();

async function inPhase(phase, f) {
  await f.nft.setPhase(phase);
  return f;
}
const allowlistOpen = async () => inPhase(Phase.Allowlist, await deploy());
const publicOpen = async () => inPhase(Phase.Public, await deploy());

describe("HimalPeaks: setup", function () {
  it("stores the settings and starts closed with nothing minted", async function () {
    const { nft, owner, treasury, al } = await loadFixture(deploy);
    expect(await nft.name()).to.equal("Himal Peaks");
    expect(await nft.symbol()).to.equal("PEAK");
    expect(await nft.owner()).to.equal(owner.address);
    expect(await nft.treasury()).to.equal(treasury.address);
    expect(await nft.maxSupply()).to.equal(MAX);
    expect(await nft.teamReserve()).to.equal(RESERVE);
    expect(await nft.allowlistPrice()).to.equal(AL_PRICE);
    expect(await nft.publicPrice()).to.equal(PUB_PRICE);
    expect(await nft.allowlistRoot()).to.equal(al.root);
    expect(await nft.phase()).to.equal(Phase.Closed);
    expect(await nft.totalMinted()).to.equal(0);
    expect(await nft.saleRemaining()).to.equal(MAX - RESERVE);
  });

  it("rejects bad constructor values", async function () {
    const { owner, treasury, al } = await loadFixture(deploy);
    const F = await ethers.getContractFactory("HimalPeaks");
    const args = (o) => {
      const a = { t: treasury.address, max: MAX, res: RESERVE, alp: AL_PRICE, pp: PUB_PRICE, root: al.root, ...o };
      return [owner.address, a.t, a.max, a.res, a.alp, a.pp, a.root, BASE];
    };
    for (const bad of [{ t: ethers.ZeroAddress }, { max: 0 }, { res: MAX + 1 }, { pp: 0 }, { alp: 0 }, { alp: PUB_PRICE + 1n }, { root: ethers.ZeroHash }]) {
      await expect(F.deploy(...args(bad))).to.be.revertedWithCustomError(F, "InvalidConfig");
    }
    await F.deploy(...args({ res: MAX })); // the whole supply as reserve is allowed
    await F.deploy(...args({ alp: PUB_PRICE })); // same price in both phases is allowed
  });
});

describe("HimalPeaks: phases", function () {
  it("nobody can mint while closed", async function () {
    const { nft, listed, al } = await loadFixture(deploy);
    await expect(nft.connect(listed[0]).allowlistMint(1, al.proofFor(listed[0].address), { value: AL_PRICE }))
      .to.be.revertedWithCustomError(nft, "WrongPhase").withArgs(Phase.Closed);
    await expect(nft.connect(listed[0]).publicMint(1, { value: PUB_PRICE })).to.be.revertedWithCustomError(nft, "WrongPhase");
  });

  it("public mint is closed during the allowlist phase, and allowlist mint during the public phase", async function () {
    const f = await loadFixture(allowlistOpen);
    await expect(f.nft.connect(f.listed[0]).publicMint(1, { value: PUB_PRICE })).to.be.revertedWithCustomError(f.nft, "WrongPhase").withArgs(Phase.Allowlist);
    await f.nft.setPhase(Phase.Public);
    await expect(f.nft.connect(f.listed[0]).allowlistMint(1, f.al.proofFor(f.listed[0].address), { value: AL_PRICE }))
      .to.be.revertedWithCustomError(f.nft, "WrongPhase").withArgs(Phase.Public);
  });

  it("only the owner can change the phase, and it emits an event", async function () {
    const { nft, outsider } = await loadFixture(deploy);
    await expect(nft.connect(outsider).setPhase(Phase.Public)).to.be.revertedWithCustomError(nft, "OwnableUnauthorizedAccount");
    await expect(nft.setPhase(Phase.Public)).to.emit(nft, "PhaseChanged").withArgs(Phase.Public);
    await expect(nft.setPhase(3)).to.be.reverted; // not a valid phase
  });
});

describe("HimalPeaks: allowlist sale", function () {
  it("a listed wallet mints at the allowlist price, ids start at 1", async function () {
    const { nft, listed, al, addr } = await loadFixture(allowlistOpen);
    const w = listed[0];
    const tx = nft.connect(w).allowlistMint(2, al.proofFor(w.address), { value: AL_PRICE * 2n });
    await expect(tx).to.emit(nft, "Minted").withArgs(w.address, 1, 2, AL_PRICE * 2n);
    await expect(tx).to.changeEtherBalances([w, addr], [-(AL_PRICE * 2n), AL_PRICE * 2n]);
    expect(await nft.ownerOf(1)).to.equal(w.address);
    expect(await nft.ownerOf(2)).to.equal(w.address);
    expect(await nft.allowlistMinted(w.address)).to.equal(2);
    expect(await nft.totalMinted()).to.equal(2);
  });

  it("a wallet not on the list is rejected, even with an empty or someone else's proof", async function () {
    const { nft, listed, outsider, al } = await loadFixture(allowlistOpen);
    await expect(nft.connect(outsider).allowlistMint(1, [], { value: AL_PRICE })).to.be.revertedWithCustomError(nft, "NotOnAllowlist");
    await expect(nft.connect(outsider).allowlistMint(1, al.proofFor(listed[0].address), { value: AL_PRICE }))
      .to.be.revertedWithCustomError(nft, "NotOnAllowlist");
  });

  it("a changed proof or a proof from a different list is rejected", async function () {
    const { nft, listed, users, al } = await loadFixture(allowlistOpen);
    const w = listed[1];
    const proof = al.proofFor(w.address);
    const tampered = [...proof];
    tampered[0] = ethers.id("not a real hash");
    await expect(nft.connect(w).allowlistMint(1, tampered, { value: AL_PRICE })).to.be.revertedWithCustomError(nft, "NotOnAllowlist");
    const other = buildAllowlist([w.address, users[12].address, users[13].address]);
    await expect(nft.connect(w).allowlistMint(1, other.proofFor(w.address), { value: AL_PRICE })).to.be.revertedWithCustomError(nft, "NotOnAllowlist");
  });

  it("an inner node of the tree cannot be used to pass as a listed wallet", async function () {
    const { nft, listed, al } = await loadFixture(allowlistOpen);
    // A proof whose first element is dropped proves an inner node, not a leaf; it must not let anyone in.
    const w = listed[2];
    const proof = al.proofFor(w.address);
    await expect(nft.connect(w).allowlistMint(1, proof.slice(1), { value: AL_PRICE })).to.be.revertedWithCustomError(nft, "NotOnAllowlist");
  });

  it("the allowlist limit is 2 per wallet, across several transactions", async function () {
    const { nft, listed, al } = await loadFixture(allowlistOpen);
    const w = listed[3];
    const proof = al.proofFor(w.address);
    await expect(nft.connect(w).allowlistMint(3, proof, { value: AL_PRICE * 3n })).to.be.revertedWithCustomError(nft, "WalletLimit").withArgs(3, 2);
    await nft.connect(w).allowlistMint(1, proof, { value: AL_PRICE });
    await nft.connect(w).allowlistMint(1, proof, { value: AL_PRICE });
    await expect(nft.connect(w).allowlistMint(1, proof, { value: AL_PRICE })).to.be.revertedWithCustomError(nft, "WalletLimit").withArgs(1, 0);
  });

  it("allowlist and public limits are separate: a listed wallet can still buy 3 in public", async function () {
    const { nft, listed, al } = await loadFixture(allowlistOpen);
    const w = listed[4];
    await nft.connect(w).allowlistMint(2, al.proofFor(w.address), { value: AL_PRICE * 2n });
    await nft.setPhase(Phase.Public);
    await nft.connect(w).publicMint(3, { value: PUB_PRICE * 3n });
    expect(await nft.balanceOf(w.address)).to.equal(5);
  });
});

describe("HimalPeaks: public sale", function () {
  it("anyone mints at the public price", async function () {
    const { nft, outsider, addr } = await loadFixture(publicOpen);
    const tx = nft.connect(outsider).publicMint(3, { value: PUB_PRICE * 3n });
    await expect(tx).to.emit(nft, "Minted").withArgs(outsider.address, 1, 3, PUB_PRICE * 3n);
    await expect(tx).to.changeEtherBalance(addr, PUB_PRICE * 3n);
    expect(await nft.publicMinted(outsider.address)).to.equal(3);
  });

  it("the public limit is 3 per wallet", async function () {
    const { nft, outsider } = await loadFixture(publicOpen);
    await expect(nft.connect(outsider).publicMint(4, { value: PUB_PRICE * 4n })).to.be.revertedWithCustomError(nft, "WalletLimit").withArgs(4, 3);
    await nft.connect(outsider).publicMint(2, { value: PUB_PRICE * 2n });
    await expect(nft.connect(outsider).publicMint(2, { value: PUB_PRICE * 2n })).to.be.revertedWithCustomError(nft, "WalletLimit").withArgs(2, 1);
  });

  it("payment must be exact: too little, too much, zero, and the allowlist price are all rejected", async function () {
    const { nft, outsider } = await loadFixture(publicOpen);
    const need = PUB_PRICE * 2n;
    for (const sent of [need - 1n, need + 1n, 0n, AL_PRICE * 2n]) {
      await expect(nft.connect(outsider).publicMint(2, { value: sent })).to.be.revertedWithCustomError(nft, "WrongPayment").withArgs(sent, need);
    }
  });

  it("minting zero tokens is rejected", async function () {
    const { nft, outsider } = await loadFixture(publicOpen);
    await expect(nft.connect(outsider).publicMint(0, { value: 0 })).to.be.revertedWithCustomError(nft, "ZeroQuantity");
  });

  it("a huge quantity cannot overflow the price or the limit check", async function () {
    const { nft, outsider } = await loadFixture(publicOpen);
    await expect(nft.connect(outsider).publicMint(ethers.MaxUint256, { value: 0 })).to.be.reverted;
    expect(await nft.totalMinted()).to.equal(0);
  });
});

describe("HimalPeaks: max supply", function () {
  it("the public can buy exactly up to maxSupply minus the reserve, then it is sold out", async function () {
    const { nft, users } = await loadFixture(publicOpen);
    // 16 for sale: 5 wallets x 3 + 1
    for (let i = 0; i < 5; i++) await nft.connect(users[i]).publicMint(3, { value: PUB_PRICE * 3n });
    await expect(nft.connect(users[5]).publicMint(2, { value: PUB_PRICE * 2n })).to.be.revertedWithCustomError(nft, "SoldOut").withArgs(2, 1);
    await nft.connect(users[5]).publicMint(1, { value: PUB_PRICE });
    expect(await nft.saleRemaining()).to.equal(0);
    await expect(nft.connect(users[6]).publicMint(1, { value: PUB_PRICE })).to.be.revertedWithCustomError(nft, "SoldOut").withArgs(1, 0);
    // the team reserve is still there, and filling it reaches exactly maxSupply
    await nft.teamMint(users[7].address, RESERVE);
    expect(await nft.totalMinted()).to.equal(MAX);
    expect(await nft.ownerOf(MAX)).to.equal(users[7].address);
    await expect(nft.ownerOf(MAX + 1)).to.be.revertedWithCustomError(nft, "ERC721NonexistentToken");
  });

  it("the sale cannot eat into the team reserve, and the team cannot mint past the reserve", async function () {
    const { nft, owner, users } = await loadFixture(publicOpen);
    await nft.teamMint(owner.address, 1);
    await expect(nft.teamMint(owner.address, RESERVE)).to.be.revertedWithCustomError(nft, "ReserveExceeded").withArgs(RESERVE, RESERVE - 1);
    await nft.teamMint(owner.address, RESERVE - 1);
    await expect(nft.teamMint(owner.address, 1)).to.be.revertedWithCustomError(nft, "ReserveExceeded").withArgs(1, 0);
    expect(await nft.saleRemaining()).to.equal(MAX - RESERVE);
    for (let i = 0; i < 5; i++) await nft.connect(users[i]).publicMint(3, { value: PUB_PRICE * 3n });
    await nft.connect(users[5]).publicMint(1, { value: PUB_PRICE });
    expect(await nft.totalMinted()).to.equal(MAX);
  });

  it("only the owner can team-mint, it is free, and zero is rejected", async function () {
    const { nft, outsider, owner } = await loadFixture(deploy);
    await expect(nft.connect(outsider).teamMint(outsider.address, 1)).to.be.revertedWithCustomError(nft, "OwnableUnauthorizedAccount");
    await expect(nft.teamMint(owner.address, 0)).to.be.revertedWithCustomError(nft, "ZeroQuantity");
    const tx = nft.teamMint(owner.address, 2); // works while Closed
    await expect(tx).to.emit(nft, "Minted").withArgs(owner.address, 1, 2, 0);
    await expect(tx).to.emit(nft, "TeamMinted").withArgs(owner.address, 2, 2);
  });

  it("with no reserve, the sale can sell the whole supply", async function () {
    const f = await deployWith({ max: 3, reserve: 0 });
    await f.nft.setPhase(Phase.Public);
    await f.nft.connect(f.outsider).publicMint(3, { value: PUB_PRICE * 3n });
    await expect(f.nft.connect(f.users[0]).publicMint(1, { value: PUB_PRICE })).to.be.revertedWithCustomError(f.nft, "SoldOut");
  });
});

describe("HimalPeaks: bots and reentrancy", function () {
  it("a bot contract cannot mint again from inside onERC721Received", async function () {
    const { nft, addr } = await loadFixture(publicOpen);
    const bot = await ethers.deployContract("ReentrantMinter", [addr]);
    const [owner] = await ethers.getSigners();
    // Give the bot money for the inner mint, so only the guard can stop it.
    await owner.sendTransaction({ to: await bot.getAddress(), value: PUB_PRICE * 5n });
    await bot.attack(1, { value: PUB_PRICE });
    expect(await bot.reentryBlocked()).to.equal(true);
    expect(await nft.balanceOf(await bot.getAddress())).to.equal(1);
    expect(await nft.totalMinted()).to.equal(1);
  });

  it("a contract that cannot hold NFTs cannot mint (no tokens get stuck)", async function () {
    const { nft, addr } = await loadFixture(publicOpen);
    const box = await ethers.deployContract("NoReceiver");
    await expect(box.mint(addr, 1, { value: PUB_PRICE })).to.be.revertedWithCustomError(nft, "ERC721InvalidReceiver");
    expect(await nft.totalMinted()).to.equal(0);
  });

  it("the per-wallet limit also holds for a wallet contract that mints in a loop", async function () {
    const { nft, addr } = await loadFixture(publicOpen);
    const bot = await ethers.deployContract("ReentrantMinter", [addr]);
    await bot.attack(3, { value: PUB_PRICE * 3n }); // inner retry is blocked
    await expect(bot.attack(1, { value: PUB_PRICE })).to.be.revertedWithCustomError(nft, "WalletLimit");
    expect(await nft.publicMinted(await bot.getAddress())).to.equal(3);
  });
});

describe("HimalPeaks: metadata", function () {
  it("tokenURI is base + id + .json, and unknown ids revert", async function () {
    const { nft, outsider } = await loadFixture(publicOpen);
    await nft.connect(outsider).publicMint(1, { value: PUB_PRICE });
    expect(await nft.tokenURI(1)).to.equal(`${BASE}1.json`);
    await expect(nft.tokenURI(2)).to.be.revertedWithCustomError(nft, "ERC721NonexistentToken");
  });

  it("the owner can change the base URI until it is frozen, then never again", async function () {
    const { nft, outsider } = await loadFixture(publicOpen);
    await nft.connect(outsider).publicMint(1, { value: PUB_PRICE });
    await expect(nft.connect(outsider).setBaseURI("x")).to.be.revertedWithCustomError(nft, "OwnableUnauthorizedAccount");
    await expect(nft.setBaseURI("ipfs://revealed/")).to.emit(nft, "BaseURIChanged").withArgs("ipfs://revealed/");
    expect(await nft.tokenURI(1)).to.equal("ipfs://revealed/1.json");
    await expect(nft.connect(outsider).freezeMetadata()).to.be.revertedWithCustomError(nft, "OwnableUnauthorizedAccount");
    await expect(nft.freezeMetadata()).to.emit(nft, "MetadataFrozen");
    await expect(nft.setBaseURI("ipfs://swapped/")).to.be.revertedWithCustomError(nft, "MetadataIsFrozen");
    expect(await nft.tokenURI(1)).to.equal("ipfs://revealed/1.json");
  });

  it("supports the ERC-721 and metadata interfaces", async function () {
    const { nft } = await loadFixture(deploy);
    expect(await nft.supportsInterface("0x80ac58cd")).to.equal(true); // ERC-721
    expect(await nft.supportsInterface("0x5b5e139f")).to.equal(true); // ERC-721 Metadata
  });
});

describe("HimalPeaks: withdraw", function () {
  it("only the owner can withdraw, and the money only goes to the treasury", async function () {
    const { nft, outsider, treasury, addr } = await loadFixture(publicOpen);
    await nft.connect(outsider).publicMint(3, { value: PUB_PRICE * 3n });
    await expect(nft.connect(outsider).withdraw()).to.be.revertedWithCustomError(nft, "OwnableUnauthorizedAccount");
    const tx = nft.withdraw();
    await expect(tx).to.emit(nft, "Withdrawn").withArgs(treasury.address, PUB_PRICE * 3n);
    await expect(tx).to.changeEtherBalances([treasury, addr], [PUB_PRICE * 3n, -(PUB_PRICE * 3n)]);
    await expect(nft.withdraw()).to.be.revertedWithCustomError(nft, "NothingToWithdraw");
  });

  it("if the treasury rejects ETH, withdraw fails and the money stays in the contract", async function () {
    const [owner, , buyer] = await ethers.getSigners();
    const bad = await ethers.deployContract("RejectingTreasury");
    const al = buildAllowlist([buyer.address]);
    const nft = await ethers.deployContract("HimalPeaks", [owner.address, await bad.getAddress(), MAX, RESERVE, AL_PRICE, PUB_PRICE, al.root, BASE]);
    await nft.setPhase(Phase.Public);
    await nft.connect(buyer).publicMint(1, { value: PUB_PRICE });
    await expect(nft.withdraw()).to.be.revertedWithCustomError(nft, "TransferFailed");
    expect(await ethers.provider.getBalance(await nft.getAddress())).to.equal(PUB_PRICE);
  });
});

describe("HimalPeaks: allowlist builder", function () {
  it("rejects an empty list, duplicates in any letter case, bad checksums and the zero address", function () {
    const a = "0x5B38Da6a701c568545dCfcB03FcB875f56beddC4";
    expect(() => buildAllowlist([])).to.throw("empty");
    expect(() => buildAllowlist([a, a.toLowerCase()])).to.throw("duplicate");
    expect(() => buildAllowlist(["0x5b38Da6a701c568545dCfcB03FcB875f56beddC4"])).to.throw();
    expect(() => buildAllowlist([ethers.ZeroAddress])).to.throw("zero address");
    expect(buildAllowlist([a]).proofFor(ethers.Wallet.createRandom().address)).to.deep.equal([]);
  });

  it("every one of 300 listed wallets gets a proof the contract accepts", async function () {
    const [owner, treasury] = await ethers.getSigners();
    const wallets = Array.from({ length: 300 }, (_, i) => new ethers.Wallet(ethers.id(`day11-al-${i}`), ethers.provider));
    const al = buildAllowlist(wallets.map((w) => w.address));
    const nft = await ethers.deployContract("HimalPeaks", [owner.address, treasury.address, 1000, 0, AL_PRICE, PUB_PRICE, al.root, BASE]);
    await nft.setPhase(Phase.Allowlist);
    for (const w of wallets) {
      await setBalance(w.address, ETH(1));
      await nft.connect(w).allowlistMint(1, al.proofFor(w.address), { value: AL_PRICE });
    }
    expect(await nft.totalMinted()).to.equal(300);
  });
});

describe("HimalPeaks: fuzz (random sales never break the rules)", function () {
  it("100 random sequences of honest and cheating mints keep every invariant", async function () {
    const f = await loadFixture(deploy);
    const wallets = f.users.slice(0, 9); // first 6 are listed
    const action = fc.record({
      kind: fc.constantFrom("al", "pub", "team", "phase"),
      who: fc.integer({ min: 0, max: wallets.length - 1 }),
      qty: fc.integer({ min: 0, max: 5 }),
      pay: fc.constantFrom("exact", "less", "more"),
      phase: fc.constantFrom(0, 1, 2),
    });

    await fc.assert(
      fc.asyncProperty(fc.array(action, { minLength: 5, maxLength: 30 }), async (steps) => {
        const nft = await ethers.deployContract("HimalPeaks", [f.owner.address, f.treasury.address, MAX, RESERVE, AL_PRICE, PUB_PRICE, f.al.root, BASE]);
        const model = { phase: 0, minted: 0, team: 0, al: {}, pub: {}, paid: 0n };
        for (const s of steps) {
          const w = wallets[s.who];
          if (s.kind === "phase") {
            await nft.setPhase(s.phase);
            model.phase = s.phase;
            continue;
          }
          if (s.kind === "team") {
            const ok = s.qty > 0 && model.team + s.qty <= RESERVE;
            const tx = nft.teamMint(w.address, s.qty);
            if (ok) { await tx; model.team += s.qty; model.minted += s.qty; } else await expect(tx).to.be.reverted;
            continue;
          }
          const isAl = s.kind === "al";
          const price = isAl ? AL_PRICE : PUB_PRICE;
          const need = price * BigInt(s.qty);
          const value = s.pay === "exact" ? need : s.pay === "less" ? (need > 0n ? need - 1n : 0n) : need + 1n;
          const bag = isAl ? model.al : model.pub;
          const limit = isAl ? 2 : 3;
          const forSale = MAX - model.minted - (RESERVE - model.team);
          const ok =
            model.phase === (isAl ? 1 : 2) && (!isAl || s.who < 6) && (bag[s.who] || 0) + s.qty <= limit &&
            value === need && s.qty > 0 && s.qty <= forSale;
          const tx = isAl
            ? nft.connect(w).allowlistMint(s.qty, f.al.proofFor(w.address), { value })
            : nft.connect(w).publicMint(s.qty, { value });
          if (ok) {
            await tx;
            bag[s.who] = (bag[s.who] || 0) + s.qty;
            model.minted += s.qty;
            model.paid += value;
          } else await expect(tx).to.be.reverted;
        }
        expect(await nft.totalMinted()).to.equal(model.minted);
        expect(await nft.totalMinted()).to.be.at.most(MAX);
        expect(await nft.teamMinted()).to.be.at.most(RESERVE);
        expect(await ethers.provider.getBalance(await nft.getAddress())).to.equal(model.paid);
        for (let i = 0; i < wallets.length; i++) {
          expect(await nft.allowlistMinted(wallets[i].address)).to.equal(model.al[i] || 0);
          expect(await nft.publicMinted(wallets[i].address)).to.equal(model.pub[i] || 0);
        }
      }),
      { numRuns: 100 }
    );
  });
});
