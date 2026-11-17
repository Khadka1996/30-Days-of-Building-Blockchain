const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { E, fee, baseFixture } = require("./helpers");

const Mode = { Repay: 0, NoApprove: 1, WrongReturn: 2, ApproveLess: 3, Reenter: 4, SendBack: 5 };

async function lenderFixture() {
  const f = await baseFixture();
  const borrower = await ethers.deployContract("TestBorrower", [f.L]);
  const B = await borrower.getAddress();
  // The borrower keeps a little HUSD to pay fees with.
  await f.husd.transfer(B, E(10_000));
  return { ...f, borrower, B };
}

describe("HimalFlashLender (ERC-3156)", function () {
  it("reports what it can lend and the fee (0.09%, rounded up)", async function () {
    const { lender, A } = await loadFixture(lenderFixture);
    expect(await lender.maxFlashLoan(A.husd)).to.equal(E(2_000_000));
    expect(await lender.maxFlashLoan(A.him)).to.equal(E(1_000_000));
    expect(await lender.flashFee(A.husd, E(100_000))).to.equal(E(90));
    expect(await lender.flashFee(A.husd, 1n)).to.equal(1n); // F-05: tiny loans are not free
    expect(await lender.flashFee(A.husd, 11_111n)).to.equal(10n); // 9.9999 → 10
    expect(await lender.CALLBACK_SUCCESS()).to.equal(ethers.id("ERC3156FlashBorrower.onFlashLoan"));
  });

  it("a good borrower borrows 1,000,000 HUSD and repays it + 900 HUSD in the same transaction", async function () {
    const { lender, borrower, B, husd, A, L } = await loadFixture(lenderFixture);
    const amount = E(1_000_000);
    await expect(borrower.borrow(A.husd, amount))
      .to.emit(lender, "FlashLoan")
      .withArgs(B, B, A.husd, amount, E(900));
    expect(await husd.balanceOf(L)).to.equal(E(2_000_900));
    expect(await husd.balanceOf(B)).to.equal(E(9_100));
    expect(await lender.feesEarned(A.husd)).to.equal(E(900));
    expect(await borrower.calls()).to.equal(1n);
  });

  it("can lend its whole balance, but not 1 wei more", async function () {
    const { lender, borrower, A } = await loadFixture(lenderFixture);
    await borrower.borrow(A.husd, E(2_000_000));
    const max = await lender.maxFlashLoan(A.husd);
    await expect(borrower.borrow(A.husd, max + 1n))
      .to.be.revertedWithCustomError(lender, "AmountTooLarge")
      .withArgs(max + 1n, max);
  });

  it("refuses unsupported tokens and zero amounts", async function () {
    const { lender, borrower, A, owner } = await loadFixture(lenderFixture);
    const other = await ethers.deployContract("HimalToken", ["Other", "OTH", E(1), owner.address]);
    const O = await other.getAddress();
    expect(await lender.maxFlashLoan(O)).to.equal(0n);
    await expect(lender.flashFee(O, 1n)).to.be.revertedWithCustomError(lender, "UnsupportedToken").withArgs(O);
    await expect(borrower.borrow(O, 1n)).to.be.revertedWithCustomError(lender, "AmountTooLarge");
    await expect(borrower.borrow(A.husd, 0n)).to.be.revertedWithCustomError(lender, "ZeroAmount");
    // switching a token off works too
    await lender.setSupported(A.husd, false);
    expect(await lender.maxFlashLoan(A.husd)).to.equal(0n);
  });

  describe("bad borrowers cannot keep the money (F-03)", function () {
    for (const [name, mode, err] of [
      ["keeps the money (never approves)", Mode.NoApprove, "ERC20InsufficientAllowance"],
      ["approves the amount but not the fee", Mode.ApproveLess, "ERC20InsufficientAllowance"],
      ["sends the money back by transfer() instead of approving", Mode.SendBack, "ERC20InsufficientAllowance"],
    ]) {
      it(`a borrower that ${name} → the whole loan reverts`, async function () {
        const { borrower, husd, A, L } = await loadFixture(lenderFixture);
        await borrower.setMode(mode);
        await expect(borrower.borrow(A.husd, E(1_000_000))).to.be.revertedWithCustomError(husd, err);
        expect(await husd.balanceOf(L)).to.equal(E(2_000_000));
      });
    }

    it("a contract that does not return the ERC-3156 magic value is refused", async function () {
      const { lender, borrower, A } = await loadFixture(lenderFixture);
      await borrower.setMode(Mode.WrongReturn);
      await expect(borrower.borrow(A.husd, E(1_000))).to.be.revertedWithCustomError(lender, "CallbackFailed");
    });

    it("a plain wallet (no onFlashLoan) cannot be a receiver", async function () {
      const { lender, ram, A } = await loadFixture(lenderFixture);
      await expect(lender.flashLoan(ram.address, A.husd, E(1), "0x")).to.be.reverted;
    });

    it("a token that takes a fee on transfer cannot under-repay: the balance check catches it", async function () {
      const { lender, borrower, B, owner, L } = await loadFixture(lenderFixture);
      const feeToken = await ethers.deployContract("FeeToken", [E(1_000_000), owner.address]);
      const T = await feeToken.getAddress();
      await lender.setSupported(T, true);
      await feeToken.transfer(L, E(100_000));
      await feeToken.transfer(B, E(10_000));
      const before = await feeToken.balanceOf(L);
      await expect(borrower.borrow(T, E(10_000))).to.be.revertedWithCustomError(lender, "NotRepaid");
      expect(await feeToken.balanceOf(L)).to.equal(before);
    });
  });

  it("re-entering flashLoan from inside the callback is blocked (F-04)", async function () {
    const { lender, borrower, A } = await loadFixture(lenderFixture);
    await borrower.setMode(Mode.Reenter);
    await expect(borrower.borrow(A.husd, E(1_000))).to.be.revertedWithCustomError(lender, "ReentrancyGuardReentrantCall");
  });

  it("only the owner can change tokens or withdraw; withdraw pays out fees", async function () {
    const { lender, borrower, husd, A, owner, attacker } = await loadFixture(lenderFixture);
    await expect(lender.connect(attacker).setSupported(A.husd, false))
      .to.be.revertedWithCustomError(lender, "OwnableUnauthorizedAccount");
    await expect(lender.connect(attacker).withdraw(A.husd, 1n, attacker.address))
      .to.be.revertedWithCustomError(lender, "OwnableUnauthorizedAccount");
    await expect(lender.setSupported(ethers.ZeroAddress, true)).to.be.revertedWithCustomError(lender, "ZeroAddress");
    await expect(lender.withdraw(A.husd, 1n, ethers.ZeroAddress)).to.be.revertedWithCustomError(lender, "ZeroAddress");
    await borrower.borrow(A.husd, E(100_000));
    await expect(lender.withdraw(A.husd, E(90), owner.address)).to.changeTokenBalance(husd, owner, E(90));
  });

  it("fee helper in the tests matches the contract", async function () {
    const { lender, A } = await loadFixture(lenderFixture);
    for (const a of [1n, 1111n, 1112n, E(1), E(123_456.789)]) expect(await lender.flashFee(A.husd, a)).to.equal(fee(a));
  });
});
