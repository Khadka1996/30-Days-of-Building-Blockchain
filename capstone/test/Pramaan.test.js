const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { S, cert, deployFixture, inOneBlock } = require("./helpers");
const { buildBatch, serialOf, docHashOf } = require("../lib/pramaan");

const DAY = 24 * 60 * 60;

describe("Pramaan — council", function () {
  it("registers institutions with a name and a unique key", async function () {
    const { p, neb, tu } = await loadFixture(deployFixture);
    expect(await p.issuerCount()).to.equal(2);
    const i = await p.issuers(1);
    expect([i.key, i.active, i.name]).to.deep.equal([neb.address, true, "National Examinations Board"]);
    expect(await p.issuerOfKey(tu.address)).to.equal(2);
    await expect(p.addIssuer(neb.address, "Copy")).to.be.revertedWithCustomError(p, "KeyInUse");
    await expect(p.addIssuer(ethers.ZeroAddress, "X")).to.be.revertedWithCustomError(p, "ZeroValue");
    await expect(p.addIssuer(ethers.Wallet.createRandom().address, "")).to.be.revertedWithCustomError(p, "ZeroValue");
  });

  it("the council key can't also be an issuer key (keeps the two roles apart)", async function () {
    const { p, council } = await loadFixture(deployFixture);
    await expect(p.addIssuer(council.address, "Council College")).to.be.revertedWithCustomError(p, "KeyInUse");
  });

  it("only the council manages institutions", async function () {
    const { p, thief, other } = await loadFixture(deployFixture);
    const now = await time.latest();
    for (const call of [
      () => p.connect(thief).addIssuer(thief.address, "Fake University"),
      () => p.connect(thief).setIssuerActive(1, false),
      () => p.connect(thief).rotateKey(1, thief.address),
      () => p.connect(thief).reportCompromise(1, now, other.address),
    ]) await expect(call()).to.be.revertedWithCustomError(p, "OwnableUnauthorizedAccount");
  });

  it("the council can't issue or revoke certificates itself", async function () {
    const { p, council } = await loadFixture(deployFixture);
    const c = cert(1);
    await expect(p.connect(council).issue(c.serial, c.docHash)).to.be.revertedWithCustomError(p, "NotIssuer");
    await expect(p.connect(council).revoke(c.serial, 1)).to.be.revertedWithCustomError(p, "NotIssuer");
  });

  it("hands over the council in two steps", async function () {
    const { p, council, other } = await loadFixture(deployFixture);
    await p.transferOwnership(other.address);
    expect(await p.owner()).to.equal(council.address);
    await p.connect(other).acceptOwnership();
    expect(await p.owner()).to.equal(other.address);
  });

  it("rejects unknown institutions", async function () {
    const { p, other } = await loadFixture(deployFixture);
    await expect(p.setIssuerActive(9, false)).to.be.revertedWithCustomError(p, "UnknownIssuer");
    await expect(p.rotateKey(9, other.address)).to.be.revertedWithCustomError(p, "UnknownIssuer");
  });
});

describe("Pramaan — single certificates", function () {
  it("issues and verifies; a changed field or wrong salt reads Unknown", async function () {
    const { p, neb, employer, NEB } = await loadFixture(deployFixture);
    const c = cert(1);
    await expect(p.connect(neb).issue(c.serial, c.docHash)).to.emit(p, "Issued").withArgs(NEB, c.serial, c.docHash);
    const [st, at] = await p.connect(employer).verify(NEB, c.serial, c.docHash);
    expect(st).to.equal(S.Valid);
    expect(at).to.equal(await time.latest());
    // A forger changes the grade on the paper: the hash no longer matches.
    const forged = docHashOf(1, { ...c.cert, result: "GPA 4.00" }, c.salt);
    expect((await p.verify(NEB, c.serial, forged))[0]).to.equal(S.Unknown);
    expect((await p.verify(NEB, c.serial, docHashOf(1, c.cert, ethers.ZeroHash)))[0]).to.equal(S.Unknown);
    expect((await p.verify(NEB, serialOf("SEE-2081-999999"), c.docHash))[0]).to.equal(S.Unknown);
  });

  it("a serial can be used only once", async function () {
    const { p, neb } = await loadFixture(deployFixture);
    const c = cert(1);
    await p.connect(neb).issue(c.serial, c.docHash);
    await expect(p.connect(neb).issue(c.serial, cert(2).docHash)).to.be.revertedWithCustomError(p, "AlreadyIssued");
  });

  it("each institution has its own namespace: TU can't issue or revoke an NEB certificate", async function () {
    const { p, neb, tu, NEB, TU } = await loadFixture(deployFixture);
    const c = cert(1);
    await p.connect(neb).issue(c.serial, c.docHash);
    // TU uses the same serial: it lands under TU's id, never under NEB's.
    await p.connect(tu).issue(c.serial, cert(2).docHash);
    await p.connect(tu).revoke(c.serial, 1);
    expect((await p.verify(NEB, c.serial, c.docHash))[0]).to.equal(S.Valid);
    expect((await p.verify(TU, c.serial, c.docHash))[0]).to.equal(S.Unknown);
  });

  it("rejects empty values and strangers", async function () {
    const { p, neb, thief } = await loadFixture(deployFixture);
    const c = cert(1);
    await expect(p.connect(neb).issue(ethers.ZeroHash, c.docHash)).to.be.revertedWithCustomError(p, "ZeroValue");
    await expect(p.connect(neb).issue(c.serial, ethers.ZeroHash)).to.be.revertedWithCustomError(p, "ZeroValue");
    await expect(p.connect(neb).revoke(c.serial, 0)).to.be.revertedWithCustomError(p, "ZeroValue");
    await expect(p.connect(thief).issue(c.serial, c.docHash)).to.be.revertedWithCustomError(p, "NotIssuer");
  });

  it("revokes with a reason, once, permanently", async function () {
    const { p, neb, NEB } = await loadFixture(deployFixture);
    const c = cert(1);
    await p.connect(neb).issue(c.serial, c.docHash);
    await expect(p.connect(neb).revoke(c.serial, 1)).to.emit(p, "Revoked").withArgs(NEB, c.serial, 1);
    const [st, , reason] = await p.verify(NEB, c.serial, c.docHash);
    expect([st, reason]).to.deep.equal([S.Revoked, 1n]);
    await expect(p.connect(neb).revoke(c.serial, 2)).to.be.revertedWithCustomError(p, "AlreadyRevoked");
  });

  it("a suspended institution can't act, but its old certificates stay valid", async function () {
    const { p, neb, NEB } = await loadFixture(deployFixture);
    const c = cert(1);
    await p.connect(neb).issue(c.serial, c.docHash);
    await expect(p.setIssuerActive(NEB, false)).to.emit(p, "IssuerStatusChanged").withArgs(NEB, false);
    await expect(p.connect(neb).issue(cert(2).serial, cert(2).docHash)).to.be.revertedWithCustomError(p, "IssuerSuspended");
    await expect(p.connect(neb).revoke(c.serial, 1)).to.be.revertedWithCustomError(p, "IssuerSuspended");
    expect((await p.verify(NEB, c.serial, c.docHash))[0]).to.equal(S.Valid);
    await p.setIssuerActive(NEB, true);
    await p.connect(neb).issue(cert(2).serial, cert(2).docHash);
  });

  it("routine key rotation: old key stops, new key starts next block, nothing distrusted", async function () {
    const { p, neb, nebNew, NEB } = await loadFixture(deployFixture);
    const c = cert(1);
    await p.connect(neb).issue(c.serial, c.docHash);
    await expect(p.rotateKey(NEB, nebNew.address)).to.emit(p, "KeyRotated").withArgs(NEB, neb.address, nebNew.address);
    await expect(p.connect(neb).issue(cert(2).serial, cert(2).docHash)).to.be.revertedWithCustomError(p, "NotIssuer");
    await p.connect(nebNew).issue(cert(2).serial, cert(2).docHash);
    expect((await p.verify(NEB, c.serial, c.docHash))[0]).to.equal(S.Valid);
    expect(await p.issuerOfKey(neb.address)).to.equal(0);
  });
});

describe("Pramaan — batches (a whole exam result in one transaction)", function () {
  async function batchFixture() {
    const f = await deployFixture();
    const certs = Array.from({ length: 50 }, (_, i) => cert(i + 1));
    const tree = buildBatch(1, certs);
    await f.p.connect(f.neb).issueBatch(tree.root, tree.count);
    return { ...f, certs, tree };
  }

  it("every certificate in the batch verifies with its proof", async function () {
    const { p, certs, tree } = await loadFixture(batchFixture);
    for (const c of certs) {
      expect((await p.verifyInBatch(1, c.serial, c.docHash, tree.proof(c.serial, c.docHash)))[0]).to.equal(S.Valid);
    }
    const b = await p.batches(1);
    expect([b.issuerId, b.count]).to.deep.equal([1n, 50n]);
  });

  it("wrong document, someone else's proof, unknown batch or an inner node all read Unknown", async function () {
    const { p, certs, tree } = await loadFixture(batchFixture);
    const [a, b] = certs;
    const forged = docHashOf(1, { ...a.cert, name: "Someone Else" }, a.salt);
    expect((await p.verifyInBatch(1, a.serial, forged, tree.proof(a.serial, a.docHash)))[0]).to.equal(S.Unknown);
    expect((await p.verifyInBatch(1, a.serial, a.docHash, tree.proof(b.serial, b.docHash)))[0]).to.equal(S.Unknown);
    expect((await p.verifyInBatch(7, a.serial, a.docHash, tree.proof(a.serial, a.docHash)))[0]).to.equal(S.Unknown);
    // Second-preimage try: present the hash of two leaves as if it were a certificate.
    const proof = tree.proof(a.serial, a.docHash);
    expect((await p.verifyInBatch(1, proof[0], proof[1], proof.slice(2)))[0]).to.equal(S.Unknown);
  });

  it("one certificate in a batch can be revoked by serial; the rest stay valid", async function () {
    const { p, neb, certs, tree } = await loadFixture(batchFixture);
    const [a, b] = certs;
    await p.connect(neb).revoke(a.serial, 1);
    expect((await p.verifyInBatch(1, a.serial, a.docHash, tree.proof(a.serial, a.docHash)))[0]).to.equal(S.Revoked);
    expect((await p.verifyInBatch(1, b.serial, b.docHash, tree.proof(b.serial, b.docHash)))[0]).to.equal(S.Valid);
  });

  it("a whole batch can be revoked, only by its own institution", async function () {
    const { p, neb, tu, certs, tree } = await loadFixture(batchFixture);
    await expect(p.connect(tu).revokeBatch(1, 3)).to.be.revertedWithCustomError(p, "NotYourBatch");
    await expect(p.connect(neb).revokeBatch(9, 3)).to.be.revertedWithCustomError(p, "UnknownBatch");
    await expect(p.connect(neb).revokeBatch(1, 0)).to.be.revertedWithCustomError(p, "ZeroValue");
    await expect(p.connect(neb).revokeBatch(1, 3)).to.emit(p, "BatchRevoked").withArgs(1, 1, 3);
    const c = certs[9];
    const [st, , reason] = await p.verifyInBatch(1, c.serial, c.docHash, tree.proof(c.serial, c.docHash));
    expect([st, reason]).to.deep.equal([S.Revoked, 3n]);
    await expect(p.connect(neb).revokeBatch(1, 3)).to.be.revertedWithCustomError(p, "AlreadyRevoked");
  });

  it("rejects an empty batch", async function () {
    const { p, neb } = await loadFixture(deployFixture);
    await expect(p.connect(neb).issueBatch(ethers.ZeroHash, 5)).to.be.revertedWithCustomError(p, "ZeroValue");
    await expect(p.connect(neb).issueBatch(ethers.id("root"), 0)).to.be.revertedWithCustomError(p, "ZeroValue");
  });
});

describe("Pramaan — stolen issuer key", function () {
  // Timeline: real certificates for weeks → key stolen on day 30 → thief acts → council reports on day 40.
  async function theftFixture() {
    const f = await deployFixture();
    const { p, neb } = f;
    const real = cert(1);
    const realLater = cert(2); // real, but issued after the theft started: must be re-issued
    const victim = cert(3);
    await p.connect(neb).issue(real.serial, real.docHash);
    await p.connect(neb).issue(victim.serial, victim.docHash);
    const batchCerts = [cert(10), cert(11)];
    const realBatch = buildBatch(1, batchCerts);
    await p.connect(neb).issueBatch(realBatch.root, 2);
    await time.increase(30 * DAY);
    const since = await time.latest();
    // The thief, holding NEB's key:
    const fake = cert(4, { name: "Thief's Customer", result: "GPA 4.00" });
    await p.connect(neb).issue(fake.serial, fake.docHash); // sells a fake certificate
    await p.connect(neb).revoke(victim.serial, 1); // cancels a real one
    await p.connect(neb).revokeBatch(1, 1); // and a real batch
    const squat = cert(5); // takes a serial the board will need later
    await p.connect(neb).issue(squat.serial, squat.docHash);
    await p.connect(neb).issue(realLater.serial, realLater.docHash);
    await time.increase(10 * DAY);
    return { ...f, real, realLater, victim, fake, squat, since, realBatch, batchCerts };
  }

  it("after the report: fakes are Distrusted, real ones stay Valid, the thief's revocations are ignored", async function () {
    const { p, nebNew, NEB, real, victim, fake, since } = await loadFixture(theftFixture);
    expect((await p.verify(NEB, fake.serial, fake.docHash))[0]).to.equal(S.Valid); // before the report it looks real
    await expect(p.reportCompromise(NEB, since, nebNew.address)).to.emit(p, "CompromiseReported");
    expect((await p.verify(NEB, fake.serial, fake.docHash))[0]).to.equal(S.Distrusted);
    expect((await p.verify(NEB, real.serial, real.docHash))[0]).to.equal(S.Valid);
    expect((await p.verify(NEB, victim.serial, victim.docHash))[0]).to.equal(S.Valid);
  });

  it("the stolen key is cut off and the new key works from the next block", async function () {
    const { p, neb, nebNew, NEB, since } = await loadFixture(theftFixture);
    await p.reportCompromise(NEB, since, nebNew.address);
    await expect(p.connect(neb).issue(cert(8).serial, cert(8).docHash)).to.be.revertedWithCustomError(p, "NotIssuer");
    const n = cert(8);
    await p.connect(nebNew).issue(n.serial, n.docHash);
    expect((await p.verify(NEB, n.serial, n.docHash))[0]).to.equal(S.Valid);
  });

  it("the board can re-issue a serial the thief squatted, and real-but-late certificates", async function () {
    const { p, nebNew, NEB, squat, realLater, since } = await loadFixture(theftFixture);
    await p.reportCompromise(NEB, since, nebNew.address);
    const proper = cert(5, { name: "Real Owner Of Serial 5" });
    await p.connect(nebNew).issue(proper.serial, proper.docHash);
    expect((await p.verify(NEB, proper.serial, proper.docHash))[0]).to.equal(S.Valid);
    expect((await p.verify(NEB, squat.serial, squat.docHash))[0]).to.equal(S.Unknown);
    await p.connect(nebNew).issue(realLater.serial, realLater.docHash);
    expect((await p.verify(NEB, realLater.serial, realLater.docHash))[0]).to.equal(S.Valid);
    // ...but a trusted record still can't be overwritten.
    await expect(p.connect(nebNew).issue(proper.serial, cert(6).docHash)).to.be.revertedWithCustomError(p, "AlreadyIssued");
  });

  it("the board can revoke properly again after the thief's revocation was ignored", async function () {
    const { p, nebNew, NEB, victim, since } = await loadFixture(theftFixture);
    await p.reportCompromise(NEB, since, nebNew.address);
    await p.connect(nebNew).revoke(victim.serial, 2);
    const [st, , reason] = await p.verify(NEB, victim.serial, victim.docHash);
    expect([st, reason]).to.deep.equal([S.Revoked, 2n]);
  });

  it("the thief's batch revocation is ignored", async function () {
    const { p, nebNew, NEB, since, realBatch, batchCerts } = await loadFixture(theftFixture);
    const [c] = batchCerts;
    const check = async () => (await p.verifyInBatch(1, c.serial, c.docHash, realBatch.proof(c.serial, c.docHash)))[0];
    expect(await check()).to.equal(S.Revoked); // what an employer saw during the theft
    await p.reportCompromise(NEB, since, nebNew.address);
    expect(await check()).to.equal(S.Valid);
  });

  it("the window covers actions in the same block as the report; the new key can't act in that block", async function () {
    const { p, neb, nebNew, NEB } = await loadFixture(deployFixture);
    const since = (await time.latest()) + 1;
    const late = cert(20);
    const early = cert(21);
    const [r1, r2, r3] = await inOneBlock([
      () => p.connect(neb).issue(late.serial, late.docHash, { gasLimit: 200000 }),
      () => p.reportCompromise(NEB, since, nebNew.address, { gasLimit: 300000 }),
      () => p.connect(nebNew).issue(early.serial, early.docHash, { gasLimit: 200000 }),
    ]);
    expect(r1.status).to.equal(1);
    expect(r2.status).to.equal(1);
    expect(r3).to.be.instanceOf(Error); // KeyNotActiveYet
    expect((await p.verify(NEB, late.serial, late.docHash))[0]).to.equal(S.Distrusted);
    await p.connect(nebNew).issue(early.serial, early.docHash);
    expect((await p.verify(NEB, early.serial, early.docHash))[0]).to.equal(S.Valid);
  });

  it("limits what the council can do: since in the future or older than 180 days is refused", async function () {
    const { p, nebNew, NEB } = await loadFixture(deployFixture);
    await time.increase(400 * DAY);
    const now = await time.latest();
    await expect(p.reportCompromise(NEB, now + 100, nebNew.address)).to.be.revertedWithCustomError(p, "BadSince");
    await expect(p.reportCompromise(NEB, now - 181 * DAY, nebNew.address)).to.be.revertedWithCustomError(p, "BadSince");
    await p.reportCompromise(NEB, now - 179 * DAY, nebNew.address);
  });

  it("at most 5 compromise windows per institution (verify stays cheap); more reports merge", async function () {
    const { p, NEB } = await loadFixture(deployFixture);
    for (let i = 0; i < 7; i++) {
      await p.reportCompromise(NEB, await time.latest(), ethers.Wallet.createRandom().address);
    }
    expect((await p.compromises(NEB)).length).to.equal(5);
  });
});

describe("Pramaan — QA findings", function () {
  it("F-1: another institution can't re-publish NEB's batch as its own", async function () {
    const { p, neb, tu } = await loadFixture(deployFixture);
    const certs = [cert(1), cert(2), cert(3)];
    const tree = buildBatch(1, certs);
    await p.connect(neb).issueBatch(tree.root, 3); // batch 1, NEB
    await p.connect(tu).issueBatch(tree.root, 3); // batch 2, TU copies the root
    const c = certs[0];
    expect((await p.verifyInBatch(1, c.serial, c.docHash, tree.proof(c.serial, c.docHash)))[0]).to.equal(S.Valid);
    expect((await p.verifyInBatch(2, c.serial, c.docHash, tree.proof(c.serial, c.docHash)))[0]).to.equal(S.Unknown);
  });

  it("F-2: a 6th stolen key can still be reported (windows merge instead of being refused)", async function () {
    const { p, NEB } = await loadFixture(deployFixture);
    for (let i = 0; i < 5; i++) {
      await p.reportCompromise(NEB, await time.latest(), ethers.Wallet.createRandom().address);
    }
    // The current key is stolen again and used for a fake...
    const signers = await ethers.getSigners();
    const stolen = signers[8];
    await p.rotateKey(NEB, stolen.address);
    await time.increase(DAY);
    const since = await time.latest();
    const fake = cert(99);
    await p.connect(stolen).issue(fake.serial, fake.docHash);
    await time.increase(DAY);
    await p.reportCompromise(NEB, since, signers[9].address); // must not revert
    expect((await p.verify(NEB, fake.serial, fake.docHash))[0]).to.equal(S.Distrusted);
    expect((await p.compromises(NEB)).length).to.equal(5);
  });

  it("F-3: the council can't renounce ownership (nobody could ever report a stolen key again)", async function () {
    const { p, council } = await loadFixture(deployFixture);
    await expect(p.renounceOwnership()).to.be.revertedWithCustomError(p, "RenounceDisabled");
    expect(await p.owner()).to.equal(council.address);
  });

  it("F-4: a retired key (e.g. the stolen one) can never be registered again", async function () {
    const { p, neb, nebNew, other, NEB } = await loadFixture(deployFixture);
    await p.reportCompromise(NEB, await time.latest(), nebNew.address);
    await expect(p.rotateKey(NEB, neb.address)).to.be.revertedWithCustomError(p, "KeyInUse");
    await expect(p.addIssuer(neb.address, "New College")).to.be.revertedWithCustomError(p, "KeyInUse");
    await p.rotateKey(NEB, other.address); // a fresh key is fine
  });
});
