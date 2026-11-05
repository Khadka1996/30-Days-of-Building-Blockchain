// Quick demo on the local Hardhat network: two crowdfunding campaigns.
// Campaign 0 (a school library, goal 10 ETH) succeeds: the creator claims once.
// Campaign 1 (a village water tank, goal 20 ETH) fails: each backer pulls their own refund.
// Prints gas per action and shows that claiming twice and refunding twice both fail.
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 24 * 60 * 60;

async function main() {
  const [maya, ram, sita, hari] = await ethers.getSigners();
  const fund = await ethers.deployContract("CrowdFund");
  await fund.waitForDeployment();
  const fundAddr = await fund.getAddress();
  console.log("CrowdFund deployed at", fundAddr);

  const eth = (n) => ethers.parseEther(String(n));
  const fmt = (wei) => ethers.formatEther(wei);
  const gas = async (label, txPromise) => {
    const receipt = await (await txPromise).wait();
    console.log(`${label.padEnd(42)} gas used: ${receipt.gasUsed}`);
    return receipt;
  };
  const reason = async (fn) => {
    try {
      await fn();
      return "accepted (unexpected!)";
    } catch (err) {
      const data = err.data || err.error?.data;
      return data ? `reverted with ${fund.interface.parseError(data).name}` : err.message;
    }
  };
  const say = (label, value) => console.log(label.padEnd(42), value);

  await gas("Maya launches #0: library, goal 10 ETH", fund.connect(maya).launch(eth(10), 7 * DAY));
  await gas("Maya launches #1: water tank, goal 20 ETH", fund.connect(maya).launch(eth(20), 7 * DAY));

  await gas("Ram pledges 6 ETH to #0", fund.connect(ram).pledge(0, { value: eth(6) }));
  await gas("Sita pledges 5 ETH to #0", fund.connect(sita).pledge(0, { value: eth(5) }));
  await gas("Hari pledges 4 ETH to #1", fund.connect(hari).pledge(1, { value: eth(4) }));
  await gas("Ram pledges 3 ETH to #1", fund.connect(ram).pledge(1, { value: eth(3) }));
  await gas("Ram takes 1 ETH back from #1 (unpledge)", fund.connect(ram).unpledge(1, eth(1)));
  say("Maya claims #0 before the deadline:", await reason(() => fund.connect(maya).claim.staticCall(0)));
  say("Hari refunds #1 before the deadline:", await reason(() => fund.connect(hari).refund.staticCall(1)));

  await time.increase(7 * DAY);
  console.log("--- 7 days later: deadlines passed ---");
  const c0 = await fund.getCampaign(0);
  const c1 = await fund.getCampaign(1);
  say("#0 raised:", `${fmt(c0.pledged)} of ${fmt(c0.goal)} ETH -> success`);
  say("#1 raised:", `${fmt(c1.pledged)} of ${fmt(c1.goal)} ETH -> failed`);
  say("Pledge to #0 after the deadline:", await reason(() => fund.connect(hari).pledge.staticCall(0, { value: eth(1) })));

  const before = await ethers.provider.getBalance(maya.address);
  const r = await gas("Maya claims #0", fund.connect(maya).claim(0));
  const got = (await ethers.provider.getBalance(maya.address)) - before + r.gasUsed * r.gasPrice;
  say("Maya received:", `${fmt(got)} ETH`);
  say("Maya claims #0 again:", await reason(() => fund.connect(maya).claim.staticCall(0)));
  say("Maya claims failed #1:", await reason(() => fund.connect(maya).claim.staticCall(1)));
  say("Ram asks a refund from successful #0:", await reason(() => fund.connect(ram).refund.staticCall(0)));

  await gas("Hari pulls his refund from #1 (4 ETH)", fund.connect(hari).refund(1));
  await gas("Ram pulls his refund from #1 (2 ETH)", fund.connect(ram).refund(1));
  say("Hari refunds #1 again:", await reason(() => fund.connect(hari).refund.staticCall(1)));
  say("Contract balance at the end:", `${fmt(await ethers.provider.getBalance(fundAddr))} ETH (owes nobody anything)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
