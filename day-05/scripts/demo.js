// Quick demo on the local Hardhat network: four escrow deals, four endings.
// Deal #0 happy path: the buyer confirms delivery, the seller is paid.
// Deal #1 dispute: the arbiter decides for the buyer, who is refunded.
// Deal #2 silent buyer: after the deadline the seller claims.
// Deal #3 silent arbiter: 30 days after the dispute the buyer takes the money back.
// Prints gas per action and shows that the wrong person can never move the money.
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 24 * 60 * 60;

async function main() {
  const [sita, ram, maya, eve] = await ethers.getSigners(); // buyer, seller, arbiter, stranger
  const escrow = await ethers.deployContract("Escrow");
  await escrow.waitForDeployment();
  const escrowAddr = await escrow.getAddress();
  console.log("Escrow deployed at", escrowAddr);

  const eth = (n) => ethers.parseEther(String(n));
  const fmt = (wei) => ethers.formatEther(wei);
  const gas = async (label, txPromise) => {
    const receipt = await (await txPromise).wait();
    console.log(`${label.padEnd(46)} gas used: ${receipt.gasUsed}`);
    return receipt;
  };
  const reason = async (fn) => {
    try {
      await fn();
      return "accepted (unexpected!)";
    } catch (err) {
      const data = err.data || err.error?.data;
      return data ? `reverted with ${escrow.interface.parseError(data).name}` : err.message;
    }
  };
  const say = (label, value) => console.log(label.padEnd(46), value);
  const open = (amount) => escrow.connect(sita).openDeal(ram.address, maya.address, 14 * DAY, { value: eth(amount) });

  // #0 — happy path
  await gas("Sita opens #0: thangka painting, 2 ETH", open(2));
  say("Ram (seller) releases #0 to himself:", await reason(() => escrow.connect(ram).confirmDelivery.staticCall(0)));
  say("Maya (arbiter) releases #0, no dispute:", await reason(() => escrow.connect(maya).resolve.staticCall(0, true)));
  await gas("Sita confirms delivery of #0", escrow.connect(sita).confirmDelivery(0));
  say("Sita confirms #0 again:", await reason(() => escrow.connect(sita).confirmDelivery.staticCall(0)));

  // #1 — dispute, arbiter refunds the buyer
  await gas("Sita opens #1: pashmina shawl, 1 ETH", open(1));
  await gas("Sita disputes #1 (wrong colour)", escrow.connect(sita).dispute(1));
  say("Eve (stranger) resolves #1:", await reason(() => escrow.connect(eve).resolve.staticCall(1, true)));
  await gas("Maya resolves #1: refund the buyer", escrow.connect(maya).resolve(1, false));

  // #2 — buyer goes silent; #3 — arbiter goes silent
  await gas("Sita opens #2: singing bowl, 0.5 ETH", open(0.5));
  await gas("Sita opens #3: khukuri knife, 1.5 ETH", open(1.5));
  await gas("Ram disputes #3 (buyer says not received)", escrow.connect(ram).dispute(3));
  say("Ram claims #2 before the deadline:", await reason(() => escrow.connect(ram).claimAfterDeadline.staticCall(2)));

  await time.increase(14 * DAY);
  console.log("--- 14 days later: deadline passed, Sita never answered on #2 ---");
  say("Sita disputes #2 after the deadline:", await reason(() => escrow.connect(sita).dispute.staticCall(2)));
  await gas("Ram claims #2 after the deadline", escrow.connect(ram).claimAfterDeadline(2));

  await time.increase(16 * DAY);
  console.log("--- 30 days after the #3 dispute: Maya never decided ---");
  await gas("Sita takes #3 back (arbiter timeout)", escrow.connect(sita).refundAfterArbiterTimeout(3));

  say("Ram is owed:", `${fmt(await escrow.owed(ram.address))} ETH (#0 + #2)`);
  say("Sita is owed:", `${fmt(await escrow.owed(sita.address))} ETH (#1 + #3)`);
  say("Maya is owed:", `${fmt(await escrow.owed(maya.address))} ETH (an arbiter never gets the money)`);
  await gas("Ram withdraws", escrow.connect(ram).withdraw());
  await gas("Sita withdraws", escrow.connect(sita).withdraw());
  say("Ram withdraws again:", await reason(() => escrow.connect(ram).withdraw.staticCall()));
  say("Contract balance at the end:", `${fmt(await ethers.provider.getBalance(escrowAddr))} ETH (owes nobody anything)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
