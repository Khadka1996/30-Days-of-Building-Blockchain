const { ethers } = require("hardhat");
const { serialOf, docHashOf, newSalt } = require("../lib/pramaan");

const S = { Unknown: 0n, Valid: 1n, Revoked: 2n, Distrusted: 3n };

/** A made-up certificate (all data is fictional). */
function cert(n, over = {}) {
  const c = {
    certNo: `SEE-2081-${String(n).padStart(6, "0")}`,
    name: `Student ${n}`,
    dateOfBirth: "2065-04-12",
    program: "Secondary Education Examination",
    result: "GPA 3.65",
    issuedOn: "2081-03-15",
    ...over,
  };
  const salt = over.salt || newSalt();
  const issuerId = over.issuerId || 1;
  delete c.salt; delete c.issuerId;
  return { cert: c, salt, issuerId, serial: serialOf(c.certNo), docHash: docHashOf(issuerId, c, salt) };
}

async function deployFixture() {
  const [council, neb, tu, thief, nebNew, employer, other] = await ethers.getSigners();
  const P = await ethers.getContractFactory("Pramaan");
  const p = await P.deploy(council.address);
  await p.addIssuer(neb.address, "National Examinations Board");
  await p.addIssuer(tu.address, "Tribhuvan University");
  return { p, council, neb, tu, thief, nebNew, employer, other, NEB: 1, TU: 2 };
}

/** Run several transactions in ONE block (automine off), then mine. Returns their receipts or errors. */
async function inOneBlock(sends) {
  await ethers.provider.send("evm_setAutomine", [false]);
  const txs = [];
  try {
    for (const s of sends) txs.push(await s());
  } finally {
    await ethers.provider.send("evm_mine", []);
    await ethers.provider.send("evm_setAutomine", [true]);
  }
  return Promise.all(txs.map((t) => t.wait().then((r) => r, (e) => e)));
}

module.exports = { S, cert, deployFixture, inOneBlock };
