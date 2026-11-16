const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { E, MAX, soon, baseFixture, reservesOf } = require("./helpers");
const { sandwich } = require("./sandwich");

describe("Day 17 — Himal Swap (pools, factory, router)", function () {
  describe("Factory", function () {
    it("creates one pool per token pair, sorted, found from both sides", async function () {
      const { factory, A } = await loadFixture(baseFixture);
      expect(await factory.allPairsLength()).to.equal(3);
      const p = await factory.getPair(A.him, A.husd);
      expect(p).to.equal(await factory.getPair(A.husd, A.him));
      const pair = await ethers.getContractAt("HimalPair", p);
      expect(BigInt(await pair.token0())).to.be.lessThan(BigInt(await pair.token1()));
      expect(await pair.factory()).to.equal(await factory.getAddress());
    });

    it("rejects the same token twice, the zero address and a second pool for the same pair", async function () {
      const { factory, A } = await loadFixture(baseFixture);
      await expect(factory.createPair(A.him, A.him)).to.be.revertedWithCustomError(factory, "IdenticalTokens");
      await expect(factory.createPair(A.him, ethers.ZeroAddress)).to.be.revertedWithCustomError(factory, "ZeroAddress");
      await expect(factory.createPair(A.husd, A.him)).to.be.revertedWithCustomError(factory, "PairExists");
    });
  });

  describe("Pair (x × y = k)", function () {
    it("first deposit: shares = √(x·y), and 1,000 LP are locked forever at 0x…dEaD", async function () {
      const { pairOf, him, husd, owner } = await loadFixture(baseFixture);
      const pair = await pairOf(him, husd);
      const total = await pair.totalSupply();
      expect(total).to.equal(316_227_766016837933199889n); // √(100,000 × 1,000,000) in wei
      expect(await pair.balanceOf(await pair.DEAD())).to.equal(1000n);
      expect(await pair.balanceOf(owner.address)).to.equal(total - 1000n);
    });

    it("a first deposit too small to cover the locked 1,000 LP is refused", async function () {
      const { factory, router, owner } = await loadFixture(baseFixture);
      const a = await ethers.deployContract("HimalToken", ["A", "A", E(1), owner.address]);
      const b = await ethers.deployContract("HimalToken", ["B", "B", E(1), owner.address]);
      for (const t of [a, b]) await t.approve(await router.getAddress(), MAX);
      await expect(
        router.addLiquidity(await a.getAddress(), await b.getAddress(), 1000n, 1000n, 0, 0, owner.address, await soon())
      ).to.be.revertedWithCustomError(await ethers.getContractAt("HimalPair", ethers.ZeroAddress), "InsufficientLiquidityMinted");
      expect(await factory.allPairsLength()).to.equal(3); // the whole call reverted, pair creation included
    });

    it("k never goes down: the 0.3% fee stays in the pool, and asking 1 wei more than the formula reverts", async function () {
      const { pairOf, him, husd, router, ram, A } = await loadFixture(baseFixture);
      const pair = await pairOf(him, husd);
      const [rIn, rOut] = await reservesOf(pair, A.husd);
      const k0 = rIn * rOut;
      const out = await router.getAmountOut(E(10_000), rIn, rOut);
      // Send 10,000 HUSD by hand, then ask for 1 wei more than allowed: the pool refuses.
      await husd.connect(ram).transfer(await pair.getAddress(), E(10_000));
      const [a0, a1] = (await pair.token0()) === A.him ? [out + 1n, 0n] : [0n, out + 1n];
      await expect(pair.swap(a0, a1, ram.address)).to.be.revertedWithCustomError(pair, "KInvariant");
      // Exactly the formula's amount works, and k grows by the fee.
      const [b0, b1] = (await pair.token0()) === A.him ? [out, 0n] : [0n, out];
      await pair.swap(b0, b1, ram.address);
      const [x, y] = await pair.getReserves();
      expect(x * y).to.be.greaterThan(k0);
    });

    it("refuses swaps with no output, too much output, a bad recipient or no input", async function () {
      const { pairOf, him, husd, ram } = await loadFixture(baseFixture);
      const pair = await pairOf(him, husd);
      const [r0] = await pair.getReserves();
      await expect(pair.swap(0, 0, ram.address)).to.be.revertedWithCustomError(pair, "InsufficientOutputAmount");
      await expect(pair.swap(r0, 0, ram.address)).to.be.revertedWithCustomError(pair, "InsufficientLiquidity");
      await expect(pair.swap(1, 0, await pair.token0())).to.be.revertedWithCustomError(pair, "InvalidTo");
      await expect(pair.swap(1, 0, await pair.getAddress())).to.be.revertedWithCustomError(pair, "InvalidTo");
      await expect(pair.swap(1, 0, ram.address)).to.be.revertedWithCustomError(pair, "InsufficientInputAmount");
    });

    it("a gift sent straight to the pool does not move the price; skim returns it, sync adds it", async function () {
      const { pairOf, him, husd, router, ram, A } = await loadFixture(baseFixture);
      const pair = await pairOf(him, husd);
      const quote0 = (await router.getAmountsOut(E(1_000), [A.husd, A.him]))[1];
      await husd.connect(ram).transfer(await pair.getAddress(), E(500_000));
      expect((await router.getAmountsOut(E(1_000), [A.husd, A.him]))[1]).to.equal(quote0);
      await pair.skim(ram.address);
      expect(await husd.balanceOf(ram.address)).to.equal(E(10_000_000));
      await husd.connect(ram).transfer(await pair.getAddress(), E(1));
      await pair.sync();
      const [rHusd] = await reservesOf(pair, A.husd);
      expect(rHusd).to.equal(E(1_000_001));
    });

    it("a huge gift plus sync cannot push reserves past 2^112 and lock every swap with an overflow (F-05)", async function () {
      const { router, owner, ram, A } = await loadFixture(baseFixture);
      const big = await ethers.deployContract("HimalToken", ["Big", "BIG", 2n ** 120n, owner.address]);
      await big.approve(await router.getAddress(), MAX);
      await router.addLiquidity(await big.getAddress(), A.husd, E(1_000), E(1_000), 0, 0, owner.address, await soon());
      const pair = await ethers.getContractAt("HimalPair", await (await ethers.getContractAt("HimalFactory", await router.factory())).getPair(await big.getAddress(), A.husd));
      // The attacker sends 2^113 BIG straight to the pool and calls sync.
      await big.transfer(await pair.getAddress(), 2n ** 113n);
      await expect(pair.sync()).to.be.revertedWithCustomError(pair, "Overflow");
      await pair.skim(owner.address); // the gift can be skimmed away; reserves were never touched
      await router.connect(ram).swapExactTokensForTokens(E(1), 0, [A.husd, await big.getAddress()], ram.address, await soon());
      expect(await pair.MAX_RESERVE()).to.equal(2n ** 112n - 1n);
    });

    it("re-entering the pool in the middle of a swap is blocked (F-06)", async function () {
      const { factory, router, owner, husd, A } = await loadFixture(baseFixture);
      const hook = await ethers.deployContract("HookToken", [E(1_000_000), owner.address]);
      await hook.approve(await router.getAddress(), MAX);
      await router.addLiquidity(await hook.getAddress(), A.husd, E(10_000), E(10_000), 0, 0, owner.address, await soon());
      const pair = await ethers.getContractAt("HimalPair", await factory.getPair(await hook.getAddress(), A.husd));
      // When the pool pays out HOOK, the token calls pair.swap again before the first swap has finished.
      const [r0, r1] = await pair.getReserves();
      const reenter = pair.interface.encodeFunctionData("swap", [r0 / 2n, r1 / 2n, owner.address]);
      await hook.arm(await pair.getAddress(), reenter);
      await expect(
        router.swapExactTokensForTokens(E(100), 0, [A.husd, await hook.getAddress()], owner.address, await soon())
      ).to.be.revertedWithCustomError(pair, "ReentrancyGuardReentrantCall");
      expect(await husd.balanceOf(await pair.getAddress())).to.equal(E(10_000));
    });
  });

  describe("Router maths", function () {
    it("getAmountOut rounds down and getAmountIn rounds up, both in the pool's favour", async function () {
      const { router } = await loadFixture(baseFixture);
      const [rIn, rOut] = [E(1_000_000), E(100_000)];
      const out = await router.getAmountOut(E(10_000), rIn, rOut);
      expect(out).to.equal((E(10_000) * 997n * rOut) / (rIn * 1000n + E(10_000) * 997n));
      const need = await router.getAmountIn(out, rIn, rOut);
      expect(need).to.be.lessThanOrEqual(E(10_000)); // never asks more than the honest amount…
      expect(await router.getAmountOut(need, rIn, rOut)).to.be.greaterThanOrEqual(out); // …and always delivers
      await expect(router.getAmountOut(0, rIn, rOut)).to.be.revertedWithCustomError(router, "InsufficientAmount");
      await expect(router.getAmountIn(rOut, rIn, rOut)).to.be.revertedWithCustomError(router, "InsufficientLiquidity");
      await expect(router.quote(1, 0, 1)).to.be.revertedWithCustomError(router, "InsufficientLiquidity");
    });

    it("bestPath picks HIM → HUSD → NPRT over the thin direct pool for a big trade, direct for a tiny one", async function () {
      const { router, A } = await loadFixture(baseFixture);
      const [bigPath, bigOut] = await router.bestPath(A.him, A.nprt, E(1_000));
      expect(bigPath).to.deep.equal([A.him, A.husd, A.nprt]);
      const direct = (await router.getAmountsOut(E(1_000), [A.him, A.nprt]))[1];
      expect(bigOut).to.be.greaterThan(direct * 2n); // the thin pool would give less than half
      // A tiny trade barely moves the thin pool, and one fee beats two fees.
      const [smallPath] = await router.bestPath(A.him, A.nprt, E(0.01));
      expect(smallPath).to.deep.equal([A.him, A.nprt]);
    });

    it("bestPath returns an empty path when no route exists, and refuses nonsense", async function () {
      const { router, owner, A } = await loadFixture(baseFixture);
      const lonely = await ethers.deployContract("HimalToken", ["L", "L", E(1), owner.address]);
      const [path, out] = await router.bestPath(await lonely.getAddress(), A.nprt, E(1));
      expect(path).to.deep.equal([]);
      expect(out).to.equal(0);
      await expect(router.bestPath(A.him, A.him, E(1))).to.be.revertedWithCustomError(router, "InvalidPath");
      await expect(router.bestPath(A.him, A.nprt, 0)).to.be.revertedWithCustomError(router, "InvalidPath");
    });
  });

  describe("Router swaps", function () {
    it("multi-hop HIM → HUSD → NPRT: Ram gets exactly the quote, and the router keeps nothing", async function () {
      const { router, r, ram, him, husd, nprt, A } = await loadFixture(baseFixture);
      const path = [A.him, A.husd, A.nprt];
      const amounts = await router.getAmountsOut(E(1_000), path);
      const before = await nprt.balanceOf(ram.address);
      await router.connect(ram).swapExactTokensForTokens(E(1_000), amounts[2], path, ram.address, await soon());
      expect((await nprt.balanceOf(ram.address)) - before).to.equal(amounts[2]);
      for (const t of [him, husd, nprt]) expect(await t.balanceOf(r)).to.equal(0);
    });

    it("exact output: buy exactly 1,000 HIM with HUSD, paying no more than the limit", async function () {
      const { router, sita, him, husd, A } = await loadFixture(baseFixture);
      const path = [A.husd, A.him];
      const [need] = await router.getAmountsIn(E(1_000), path);
      const h0 = await husd.balanceOf(sita.address);
      await expect(
        router.connect(sita).swapTokensForExactTokens(E(1_000), need - 1n, path, sita.address, await soon())
      ).to.be.revertedWithCustomError(router, "ExcessiveInputAmount");
      await router.connect(sita).swapTokensForExactTokens(E(1_000), need, path, sita.address, await soon());
      expect(await him.balanceOf(sita.address)).to.equal(E(10_001_000));
      expect(h0 - (await husd.balanceOf(sita.address))).to.equal(need);
    });

    it("slippage limit: asking for 1 wei more than the pool can give reverts with the real numbers", async function () {
      const { router, ram, A } = await loadFixture(baseFixture);
      const path = [A.husd, A.him];
      const [, out] = await router.getAmountsOut(E(5_000), path);
      await expect(router.connect(ram).swapExactTokensForTokens(E(5_000), out + 1n, path, ram.address, await soon()))
        .to.be.revertedWithCustomError(router, "InsufficientOutputAmount")
        .withArgs(out, out + 1n);
    });

    it("refuses bad paths, missing pools and the zero address", async function () {
      const { router, ram, owner, A } = await loadFixture(baseFixture);
      const d = await soon();
      const lonely = await (await ethers.deployContract("HimalToken", ["L", "L", E(1), owner.address])).getAddress();
      const swap = (path, to = ram.address) => router.connect(ram).swapExactTokensForTokens(E(1), 0, path, to, d);
      await expect(swap([A.him])).to.be.revertedWithCustomError(router, "InvalidPath");
      await expect(swap([A.him, A.husd, A.nprt, A.him, A.husd])).to.be.revertedWithCustomError(router, "InvalidPath");
      await expect(swap([A.him, lonely])).to.be.revertedWithCustomError(router, "PairMissing").withArgs(A.him, lonely);
      await expect(swap([A.him, A.him])).to.be.revertedWithCustomError(router, "PairMissing");
      await expect(swap([A.him, A.husd], ethers.ZeroAddress)).to.be.revertedWithCustomError(router, "ZeroAddress");
    });

    it("refuses too many connectors or a zero factory at deploy", async function () {
      const { factory, A } = await loadFixture(baseFixture);
      const F = await ethers.getContractFactory("HimalRouter");
      const fa = await factory.getAddress();
      await expect(F.deploy(fa, Array(6).fill(A.husd))).to.be.revertedWithCustomError(F, "TooManyConnectors");
      await expect(F.deploy(ethers.ZeroAddress, [])).to.be.revertedWithCustomError(F, "ZeroAddress");
      await expect(F.deploy(fa, [ethers.ZeroAddress])).to.be.revertedWithCustomError(F, "ZeroAddress");
    });
  });

  describe("Security focus: slippage and sandwich attacks", function () {
    it("WITHOUT a slippage limit Ram is sandwiched in one block and the attacker profits (F-01)", async function () {
      const f = await loadFixture(baseFixture);
      const [, fair] = await f.router.getAmountsOut(E(50_000), [f.A.husd, f.A.him]);
      const res = await sandwich(f, { victimIn: E(50_000), victimMin: 0n, attackIn: E(200_000) });
      expect(res.sameBlock).to.equal(true);
      expect(res.order).to.deep.equal([0, 1, 2]); // attacker, Ram, attacker
      expect(res.status).to.deep.equal([1, 1, 1]);
      expect(res.ramGot).to.be.lessThan((fair * 75n) / 100n); // Ram lost over 25% of his HIM
      expect(res.attackerProfit).to.be.greaterThan(E(10_000)); // paid for by Ram
    });

    it("WITH a 0.5% slippage limit Ram's swap reverts, nothing is lost, and the attack loses money (F-01)", async function () {
      const f = await loadFixture(baseFixture);
      const [, fair] = await f.router.getAmountsOut(E(50_000), [f.A.husd, f.A.him]);
      const min = (fair * 995n) / 1000n;
      const ramHusd = await f.husd.balanceOf(f.ram.address);
      const res = await sandwich(f, { victimIn: E(50_000), victimMin: min, attackIn: E(200_000) });
      expect(res.status).to.deep.equal([1, 0, 1]); // Ram's swap reverted
      expect(res.ramGot).to.equal(0);
      expect(await f.husd.balanceOf(f.ram.address)).to.equal(ramHusd); // Ram keeps all his HUSD
      expect(res.attackerProfit).to.be.lessThan(0); // two swaps, two fees, no victim
    });

    it("a small attack that stays inside Ram's 0.5% limit cannot take more than 0.5% (F-01)", async function () {
      const f = await loadFixture(baseFixture);
      const [, fair] = await f.router.getAmountsOut(E(50_000), [f.A.husd, f.A.him]);
      const min = (fair * 995n) / 1000n;
      const res = await sandwich(f, { victimIn: E(50_000), victimMin: min, attackIn: E(1_000) });
      expect(res.status).to.deep.equal([1, 1, 1]);
      expect(res.ramGot).to.be.greaterThanOrEqual(min);
    });

    it("deadline: a swap that waited 2 hours in the queue refuses to run at the new price (F-02)", async function () {
      const { router, ram, A } = await loadFixture(baseFixture);
      const deadline = await soon(20);
      await time.increase(2 * 60 * 60);
      await expect(router.connect(ram).swapExactTokensForTokens(E(1), 0, [A.him, A.husd], ram.address, deadline))
        .to.be.revertedWithCustomError(router, "Expired");
      await expect(router.connect(ram).addLiquidity(A.him, A.husd, E(1), E(10), 0, 0, ram.address, deadline))
        .to.be.revertedWithCustomError(router, "Expired");
      await expect(router.connect(ram).removeLiquidity(A.him, A.husd, 1, 0, 0, ram.address, deadline))
        .to.be.revertedWithCustomError(router, "Expired");
    });

    it("adding liquidity after the price was pushed reverts on the minimum amounts (F-03)", async function () {
      const { router, ram, attacker, A } = await loadFixture(baseFixture);
      // Ram plans to add 1,000 HIM + 10,000 HUSD at $10, accepting at most 1% less of each.
      const d = await soon();
      await router.connect(attacker).swapExactTokensForTokens(E(200_000), 0, [A.husd, A.him], attacker.address, d);
      await expect(
        router.connect(ram).addLiquidity(A.him, A.husd, E(1_000), E(10_000), E(990), E(9_900), ram.address, d)
      ).to.be.revertedWithCustomError(router, "InsufficientAAmount");
    });

    it("add and remove liquidity at the pool ratio, with minimums on the way out too", async function () {
      const { router, pairOf, him, husd, ram, A } = await loadFixture(baseFixture);
      const d = await soon();
      // Ram offers too much HUSD: the router uses only what matches 1,000 HIM at $10.
      await router.connect(ram).addLiquidity(A.him, A.husd, E(1_000), E(20_000), E(1_000), E(9_999), ram.address, d);
      expect(await husd.balanceOf(ram.address)).to.equal(E(10_000_000) - E(10_000));
      const pair = await pairOf(him, husd);
      const lp = await pair.balanceOf(ram.address);
      await pair.connect(ram).approve(await router.getAddress(), lp);
      await expect(
        router.connect(ram).removeLiquidity(A.him, A.husd, lp, E(1_000), E(10_000), ram.address, d)
      ).to.be.revertedWithCustomError(router, "InsufficientAAmount"); // rounding down leaves him 1 wei short
      await router.connect(ram).removeLiquidity(A.him, A.husd, lp, E(999.999), E(9_999.99), ram.address, d);
      expect(await him.balanceOf(ram.address)).to.be.closeTo(E(10_000_000), 10n);
      expect(await him.balanceOf(ram.address)).to.be.lessThanOrEqual(E(10_000_000)); // never more than put in
    });
  });

  describe("Odd tokens", function () {
    async function feeFixture() {
      const f = await baseFixture();
      const fee = await ethers.deployContract("FeeToken", [E(10_000_000), f.owner.address]);
      await fee.approve(f.r, MAX);
      await f.router.addLiquidity(await fee.getAddress(), f.A.husd, E(100_000), E(100_000), 0, 0, f.owner.address, await soon());
      await fee.transfer(f.ram.address, E(10_000));
      await fee.connect(f.ram).approve(f.r, MAX);
      return { ...f, fee, F: await fee.getAddress() };
    }

    it("selling a fee-on-transfer token: the pool receives less than the quote, so the swap reverts (F-04)", async function () {
      const { router, ram, F, A, factory } = await loadFixture(feeFixture);
      const pair = await ethers.getContractAt("HimalPair", await factory.getPair(F, A.husd));
      await expect(router.connect(ram).swapExactTokensForTokens(E(1_000), 0, [F, A.husd], ram.address, await soon()))
        .to.be.revertedWithCustomError(pair, "KInvariant");
    });

    it("buying a fee-on-transfer token: the router checks what really arrived, not what the maths said (F-04)", async function () {
      const { router, ram, F, A } = await loadFixture(feeFixture);
      const path = [A.husd, F];
      const [, out] = await router.getAmountsOut(E(1_000), path);
      const arrives = out - out / 100n;
      await expect(router.connect(ram).swapExactTokensForTokens(E(1_000), out, path, ram.address, await soon()))
        .to.be.revertedWithCustomError(router, "InsufficientOutputAmount")
        .withArgs(arrives, out);
    });
  });
});
