// The ERC-1271 contract wallet used to test smart-wallet logins.
const { expect } = require("chai");
const { ethers } = require("hardhat");

const MAGIC = "0x1626ba7e";
const NO = "0xffffffff";
const N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141"); // secp256k1 order

describe("SmartWallet (ERC-1271)", () => {
  let wallet, owner, other;
  beforeEach(async () => {
    [owner, other] = await ethers.getSigners();
    wallet = await ethers.deployContract("SmartWallet", [owner.address]);
  });

  it("accepts the owner's signature and rejects anyone else's", async () => {
    const hash = ethers.hashMessage("hello");
    expect(await wallet.isValidSignature(hash, await owner.signMessage("hello"))).to.equal(MAGIC);
    expect(await wallet.isValidSignature(hash, await other.signMessage("hello"))).to.equal(NO);
    expect(await wallet.isValidSignature(ethers.hashMessage("other"), await owner.signMessage("hello"))).to.equal(NO);
  });

  it("answers 'no' (never reverts, never 'yes') for junk and malleable signatures", async () => {
    const hash = ethers.hashMessage("hello");
    const sig = ethers.Signature.from(await owner.signMessage("hello"));
    // Same signature with s flipped to the high half: valid maths, but non-canonical.
    const highS = ethers.concat([sig.r, ethers.toBeHex(N - BigInt(sig.s), 32), sig.v === 27 ? "0x1c" : "0x1b"]);
    for (const bad of ["0x", "0x1234", ethers.ZeroHash + "00".repeat(33), highS]) {
      expect(await wallet.isValidSignature(hash, bad)).to.equal(NO);
    }
  });

  it("only the owner can make it act", async () => {
    const todo = await ethers.deployContract("TodoList");
    const data = todo.interface.encodeFunctionData("addTask", ["from my smart wallet"]);
    await expect(wallet.connect(other).execute(await todo.getAddress(), 0, data)).to.be.revertedWithCustomError(wallet, "NotOwner");
    await wallet.execute(await todo.getAddress(), 0, data);
    expect((await todo.getTasks(await wallet.getAddress()))[0].text).to.equal("from my smart wallet");
  });

  it("refuses a zero owner and reverts when the inner call fails", async () => {
    await expect(ethers.deployContract("SmartWallet", [ethers.ZeroAddress])).to.be.revertedWithCustomError(wallet, "ZeroOwner");
    const todo = await ethers.deployContract("TodoList");
    const empty = todo.interface.encodeFunctionData("addTask", [""]);
    await expect(wallet.execute(await todo.getAddress(), 0, empty)).to.be.revertedWithCustomError(wallet, "CallFailed");
    await expect(wallet.execute(ethers.ZeroAddress, 1, "0x", { value: 0 })).to.be.revertedWithCustomError(wallet, "ZeroTarget");
  });
});
