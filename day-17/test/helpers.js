const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const E = (n) => ethers.parseEther(String(n));
const MAX = ethers.MaxUint256;

// A deadline 20 minutes from the latest block (what a wallet would set).
async function soon(minutes = 20) {
  return (await time.latest()) + minutes * 60;
}

// Three tokens and three pools, priced like the real world:
//   HIM/HUSD    100,000 HIM   : 1,000,000 HUSD     (1 HIM = $10)       deep
//   HUSD/NPRT 1,000,000 HUSD  : 133,000,000 NPRT   (1 HUSD = Rs 133)   deep
//   HIM/NPRT        500 HIM   : 665,000 NPRT       (1 HIM = Rs 1,330)  thin
// The router knows HUSD as a connector, so HIM → NPRT can go direct or via HUSD.
// Owner provides all liquidity; Ram and Sita trade; the attacker tries to sandwich them.
async function baseFixture() {
  const [owner, ram, sita, hari, attacker] = await ethers.getSigners();
  const supply = E(1_000_000_000);
  const him = await ethers.deployContract("HimalToken", ["Himal Token", "HIM", supply, owner.address]);
  const husd = await ethers.deployContract("HimalToken", ["Himal Dollar", "HUSD", supply, owner.address]);
  const nprt = await ethers.deployContract("HimalToken", ["Nepali Rupee Token", "NPRT", supply, owner.address]);
  const factory = await ethers.deployContract("HimalFactory");
  const router = await ethers.deployContract("HimalRouter", [await factory.getAddress(), [await husd.getAddress()]]);
  const r = await router.getAddress();

  for (const s of [owner, ram, sita, hari, attacker]) {
    for (const t of [him, husd, nprt]) {
      if (s !== owner) await t.transfer(s.address, E(10_000_000));
      await t.connect(s).approve(r, MAX);
    }
  }
  const add = async (a, b, x, y) =>
    router.addLiquidity(await a.getAddress(), await b.getAddress(), x, y, 0, 0, owner.address, await soon());
  await add(him, husd, E(100_000), E(1_000_000));
  await add(husd, nprt, E(1_000_000), E(133_000_000));
  await add(him, nprt, E(500), E(665_000));

  const pairOf = async (a, b) =>
    ethers.getContractAt("HimalPair", await factory.getPair(await a.getAddress(), await b.getAddress()));
  const A = {
    him: await him.getAddress(),
    husd: await husd.getAddress(),
    nprt: await nprt.getAddress(),
  };
  return { owner, ram, sita, hari, attacker, him, husd, nprt, factory, router, r, pairOf, A };
}

// Reserves of a pair in the order (tokenA, tokenB).
async function reservesOf(pair, tokenA) {
  const [r0, r1] = await pair.getReserves();
  return (await pair.token0()) === tokenA ? [r0, r1] : [r1, r0];
}

module.exports = { E, MAX, soon, baseFixture, reservesOf };
