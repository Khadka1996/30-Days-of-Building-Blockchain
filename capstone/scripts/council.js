// Council actions (register an institution, suspend/reinstate, rotate a key, report a stolen key).
//   ACTION=add-issuer ISSUER_KEY=0x… ISSUER_NAME="National Examinations Board" npx hardhat run scripts/council.js --network sepolia
//   ACTION=suspend|reinstate ISSUER_ID=2 …       ACTION=rotate ISSUER_ID=1 ISSUER_KEY=0xNEW …
//   ACTION=compromise ISSUER_ID=1 SINCE=<unix time> ISSUER_KEY=0xNEW …
// If the signer is not the council (the council is a Safe multisig), it prints the transaction
// (to + data) to paste into the Safe's Transaction Builder instead of sending it.
const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");

async function main() {
  const { ethers, network } = hre;
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, `../deployments/${network.name}.json`), "utf8"));
  const p = await ethers.getContractAt("Pramaan", dep.contract);
  const { ACTION, ISSUER_KEY, ISSUER_NAME, ISSUER_ID, SINCE } = process.env;
  const calls = {
    "add-issuer": () => ["addIssuer", [ISSUER_KEY, ISSUER_NAME]],
    suspend: () => ["setIssuerActive", [Number(ISSUER_ID), false]],
    reinstate: () => ["setIssuerActive", [Number(ISSUER_ID), true]],
    rotate: () => ["rotateKey", [Number(ISSUER_ID), ISSUER_KEY]],
    compromise: () => ["reportCompromise", [Number(ISSUER_ID), Number(SINCE), ISSUER_KEY]],
  };
  if (!calls[ACTION]) throw new Error(`ACTION must be one of: ${Object.keys(calls).join(", ")}`);
  const [fn, args] = calls[ACTION]();
  const [signer] = await ethers.getSigners();
  const owner = await p.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    console.log(`The council is ${owner} (a multisig). Propose this transaction there:`);
    console.log(JSON.stringify({ to: dep.contract, value: "0", data: p.interface.encodeFunctionData(fn, args) }, null, 2));
    return;
  }
  await p[fn].staticCall(...args); // fail here, with the reason, before paying gas
  const tx = await p[fn](...args);
  const r = await tx.wait();
  console.log(`${fn}(${args.join(", ")}) · tx ${tx.hash} · gas ${r.gasUsed}`);
}

main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
