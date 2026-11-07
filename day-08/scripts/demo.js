// Quick demo on the local Hardhat network: my own token (HIM) and a once-a-day faucet.
// Ram and Sita claim, Ram tries again too soon, then an attacker with 50 brand-new
// addresses tries to drain the faucet in one transaction and gets only one day's budget.
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 24 * 60 * 60;

async function main() {
  const [owner, ram, sita, eve] = await ethers.getSigners();
  const HIM = (n) => ethers.parseEther(String(n));
  const fmt = (wei) => Number(ethers.formatEther(wei)).toLocaleString("en-US");
  const say = (label, value) => console.log(label.padEnd(46), value);
  const gas = async (label, txPromise) => {
    const receipt = await (await txPromise).wait();
    say(label, `gas used: ${receipt.gasUsed}`);
    return receipt;
  };
  const reason = async (contract, fn) => {
    try {
      await fn();
      return "accepted (unexpected!)";
    } catch (err) {
      const data = err.data || err.error?.data;
      return data ? `reverted with ${contract.interface.parseError(data).name}` : err.message;
    }
  };

  const token = await ethers.deployContract("HimalToken");
  const tokenAddr = await token.getAddress();
  const faucet = await ethers.deployContract("Faucet", [tokenAddr, HIM(100), HIM(1000)]);
  const faucetAddr = await faucet.getAddress();
  say("HimalToken (HIM) deployed at", tokenAddr);
  say("Total supply (fixed, no mint function)", `${fmt(await token.totalSupply())} HIM`);
  say("Faucet deployed at", faucetAddr);
  say("Rules", "100 HIM per claim, 24 h wait, 1,000 HIM per day");
  await gas("Owner puts 100,000 HIM in the faucet", token.transfer(faucetAddr, HIM(100000)));

  // Start at 01:00 UTC on a fresh day so the daily budget is clear.
  await time.setNextBlockTimestamp((Math.floor((await time.latest()) / DAY) + 1) * DAY + 3600);
  await gas("Ram claims", faucet.connect(ram).claim());
  await gas("Sita claims", faucet.connect(sita).claim());
  say("Ram's balance", `${fmt(await token.balanceOf(ram.address))} HIM`);
  say("Ram claims again right away:", await reason(faucet, () => faucet.connect(ram).claim.staticCall()));
  say("Ram must wait", `${(Number(await faucet.waitTime(ram.address)) / 3600).toFixed(1)} hours`);
  say("Left in today's budget", `${fmt(await faucet.remainingToday())} HIM`);

  console.log("--- attack: one person, 50 brand-new addresses, one transaction ---");
  const attacker = await ethers.deployContract("SybilAttacker");
  await gas("Eve's 50-address attack", attacker.connect(eve).attack(faucetAddr, tokenAddr, 50));
  say("Addresses that got tokens", `${await attacker.successes()} of 50`);
  say("Eve received", `${fmt(await token.balanceOf(eve.address))} HIM (not 5,000)`);
  say("Faucet still holds", `${fmt(await token.balanceOf(faucetAddr))} HIM`);
  say("A new user claims today:", await reason(faucet, () => faucet.connect(owner).claim.staticCall()));

  await time.increase(DAY);
  console.log("--- 24 hours later ---");
  say("Left in today's budget", `${fmt(await faucet.remainingToday())} HIM`);
  await gas("Ram claims again", faucet.connect(ram).claim());
  say("Ram's balance", `${fmt(await token.balanceOf(ram.address))} HIM`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
