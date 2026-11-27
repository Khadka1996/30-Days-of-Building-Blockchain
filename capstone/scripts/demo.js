// Pramaan demo on the local Hardhat chain. All people and certificates are fictional.
//   npm run demo
const { ethers, network } = require("hardhat");
const { serialOf, docHashOf, newSalt, buildBatch, STATUS, REASON } = require("../lib/pramaan");

const fmt = (n) => Number(n).toLocaleString("en-US");
const line = (label, text) => console.log(`  ${label.padEnd(34)} ${text}`);

function makeCert(issuerId, certNo, over = {}) {
  const cert = {
    certNo,
    name: "Sita Kumari Shrestha",
    dateOfBirth: "2063-08-21",
    program: "Bachelor of Business Studies",
    result: "First Division",
    issuedOn: "2081-09-10",
    ...over,
  };
  const salt = newSalt();
  return { cert, salt, serial: serialOf(certNo), docHash: docHashOf(issuerId, cert, salt) };
}

async function gasOf(txPromise) {
  return (await (await txPromise).wait()).gasUsed;
}

async function main() {
  const [council, nebKey, tuKey, kuKey, nebNewKey] = await ethers.getSigners();
  const p = await (await ethers.getContractFactory("Pramaan")).deploy(council.address);
  const say = async (label, call) => {
    const [st, , reason] = await call;
    line(label, `→ ${STATUS[Number(st)]}${reason ? ` (${REASON[Number(reason)]})` : ""}`);
    return STATUS[Number(st)];
  };

  console.log("\n1. The council registers three institutions");
  const addGas = await gasOf(p.addIssuer(nebKey.address, "National Examinations Board"));
  await p.addIssuer(tuKey.address, "Tribhuvan University");
  await p.addIssuer(kuKey.address, "Kathmandu University");
  line("institutions", `${await p.issuerCount()} (gas to add one: ${fmt(addGas)})`);

  console.log("\n2. NEB publishes a whole exam result in ONE transaction");
  const N = 10000;
  const t0 = Date.now();
  const results = Array.from({ length: N }, (_, i) =>
    makeCert(1, `SEE-2081-${String(i + 1).padStart(6, "0")}`, {
      name: `Student ${i + 1}`,
      program: "Secondary Education Examination",
      result: `GPA ${(2 + (i % 21) / 10).toFixed(2)}`,
    }),
  );
  const tree = buildBatch(1, results);
  const ms = Date.now() - t0;
  const batchGas = await gasOf(p.connect(nebKey).issueBatch(tree.root, N));
  line("certificates in the batch", `${fmt(N)} (hashes + tree built in ${(ms / 1000).toFixed(1)} s)`);
  line("gas for the whole batch", `${fmt(batchGas)} → ${(Number(batchGas) / N).toFixed(1)} gas per certificate`);

  console.log("\n3. TU publishes one degree on its own");
  const degree = makeCert(2, "TU-BBS-2081-004512");
  const issueGas = await gasOf(p.connect(tuKey).issue(degree.serial, degree.docHash));
  line("gas for one certificate", fmt(issueGas));

  console.log("\n4. An employer in Doha checks certificates (free, read-only)");
  const see = results[4211];
  const proof = tree.proof(see.serial, see.docHash);
  await say("real SEE result (in the batch)", p.verifyInBatch(1, see.serial, see.docHash, proof));
  const sizes = results.map((r) => tree.proof(r.serial, r.docHash).length);
  line("  proof size", `${Math.min(...sizes)}–${Math.max(...sizes)} hashes for ${fmt(N)} certificates (this one ${proof.length})`);
  const verifyGas = await p.verifyInBatch.estimateGas(1, see.serial, see.docHash, proof);
  line("  gas to check (paid by nobody)", fmt(verifyGas));
  await say("real TU degree", p.verify(2, degree.serial, degree.docHash));
  const forged = docHashOf(2, { ...degree.cert, result: "Distinction" }, degree.salt);
  await say("same degree, grade changed", p.verify(2, degree.serial, forged));
  const madeUp = makeCert(2, "TU-BBS-2081-999999");
  await say("made-up degree, never issued", p.verify(2, madeUp.serial, madeUp.docHash));
  const copied = buildBatch(3, results.slice(0, 2)); // KU tries to copy NEB's certificates
  await p.connect(kuKey).issueBatch(copied.root, 2);
  await say("NEB result re-published by KU", p.verifyInBatch(2, results[0].serial, results[0].docHash, tree.proof(results[0].serial, results[0].docHash)));

  console.log("\n5. TU finds a degree was obtained by fraud and revokes it");
  const revokeGas = await gasOf(p.connect(tuKey).revoke(degree.serial, 1));
  await say("the revoked degree", p.verify(2, degree.serial, degree.docHash));
  line("  gas to revoke", fmt(revokeGas));

  console.log("\n6. NEB's key is stolen");
  const day = 86400;
  await network.provider.send("evm_increaseTime", [20 * day]);
  await network.provider.send("evm_mine");
  const since = (await ethers.provider.getBlock("latest")).timestamp;
  const fake = makeCert(1, "SEE-2081-777777", { name: "Thief's Customer", result: "GPA 4.00", program: "Secondary Education Examination" });
  await p.connect(nebKey).issue(fake.serial, fake.docHash);
  await p.connect(nebKey).revoke(see.serial, 1);
  await say("fake sold by the thief (before)", p.verify(1, fake.serial, fake.docHash));
  await say("real result, 'revoked' by thief", p.verifyInBatch(1, see.serial, see.docHash, proof));
  await network.provider.send("evm_increaseTime", [3 * day]);
  await network.provider.send("evm_mine");
  const reportGas = await gasOf(p.reportCompromise(1, since, nebNewKey.address));
  console.log("   … 3 days later the council reports the theft and gives NEB a new key");
  await say("fake (after the report)", p.verify(1, fake.serial, fake.docHash));
  await say("real result (after the report)", p.verifyInBatch(1, see.serial, see.docHash, proof));
  let blocked = false;
  try {
    await p.connect(nebKey).issue(serialOf("SEE-2081-888888"), ethers.id("x"));
  } catch {
    blocked = true;
  }
  line("stolen key tries again", blocked ? "→ refused (NotIssuer)" : "→ ACCEPTED (bug!)");
  const fresh = makeCert(1, "SEE-2081-010001", { program: "Secondary Education Examination" });
  await p.connect(nebNewKey).issue(fresh.serial, fresh.docHash);
  await say("new certificate with the new key", p.verify(1, fresh.serial, fresh.docHash));
  line("  gas to report the theft", fmt(reportGas));
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
