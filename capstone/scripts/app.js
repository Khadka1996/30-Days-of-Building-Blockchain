// npm run app — the whole Pramaan stack on your computer:
// a Hardhat JSON-RPC node (chain 31337) on :8545, the contract with two institutions, and the web app on :4029.
// Use the "local test wallet" on the portal (no MetaMask needed), upload app/sample/see-2081-sample.csv,
// publish, then open a verify link. Ctrl+C to stop.
const hre = require("hardhat");
const { TASK_NODE_CREATE_SERVER } = require("hardhat/builtin-tasks/task-names");
const { build } = require("../app/build");
const { createAppServer } = require("../app/server");

async function main() {
  const rpc = await hre.run(TASK_NODE_CREATE_SERVER, { hostname: "127.0.0.1", port: 8545, provider: hre.network.provider });
  await rpc.listen();
  const [council, neb, tu] = await hre.ethers.getSigners();
  const p = await (await hre.ethers.getContractFactory("Pramaan")).deploy(council.address);
  await p.addIssuer(neb.address, "National Examinations Board");
  await p.addIssuer(tu.address, "Tribhuvan University");
  await build({ quiet: true });
  const config = {
    chainId: 31337,
    networkName: "Hardhat (local)",
    rpcUrl: "http://127.0.0.1:8545",
    contract: await p.getAddress(),
    devAccounts: [
      { label: "National Examinations Board", address: neb.address },
      { label: "Tribhuvan University", address: tu.address },
      { label: "Not an institution", address: council.address },
    ],
  };
  const app = await createAppServer({ config, port: 4029 });
  console.log(`Pramaan contract  ${config.contract} (chain 31337, RPC http://127.0.0.1:8545)`);
  console.log(`Verifier          ${app.url}/verify.html`);
  console.log(`Institution portal ${app.url}/portal.html  → "Use local test wallet", then upload app/sample/see-2081-sample.csv`);
  await new Promise(() => {}); // keep running until Ctrl+C
}

main().catch((e) => { console.error(e); process.exit(1); });
