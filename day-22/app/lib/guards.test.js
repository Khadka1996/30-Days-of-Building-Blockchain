import { test } from "node:test";
import assert from "node:assert/strict";
import { BaseError, ContractFunctionExecutionError, ContractFunctionRevertedError, UserRejectedRequestError, encodeErrorResult } from "viem";
import { checkNetwork, classifyError, parseDeposit, validateTaskText } from "./guards.js";
import deployments from "./deployments.json" with { type: "json" };

const piggyAbi = deployments.contracts.PiggyBank.abi;

test("checkNetwork: only chain 31337 passes", () => {
  assert.equal(checkNetwork(31337, 31337).ok, true);
  assert.equal(checkNetwork(1, 31337).ok, false);
  assert.match(checkNetwork(1, 31337).message, /chain 1\b/);
  assert.equal(checkNetwork(undefined, 31337).ok, false);
  assert.equal(checkNetwork("31337", 31337).ok, true); // tolerate string ids
});

test("classifyError: wallet rejection, found deep in the cause chain", () => {
  const raw = Object.assign(new Error("User rejected the request."), { code: 4001 });
  assert.equal(classifyError(raw).kind, "rejected");
  const wrapped = new BaseError("Request failed", { cause: new UserRejectedRequestError(raw) });
  assert.equal(classifyError(wrapped).kind, "rejected");
});

test("classifyError: wrong network", () => {
  const e = Object.assign(new Error("x"), { name: "ConnectorChainMismatchError" });
  assert.equal(classifyError(e).kind, "wrong-network");
  assert.equal(classifyError(Object.assign(new Error("y"), { code: 4902 })).kind, "wrong-network");
});

test("classifyError: decodes a contract custom error into plain words", () => {
  const data = encodeErrorResult({ abi: piggyAbi, errorName: "StillLocked", args: [123n, 100n] });
  const revert = new ContractFunctionRevertedError({ abi: piggyAbi, data, functionName: "withdraw" });
  const err = new ContractFunctionExecutionError(revert, { abi: piggyAbi, functionName: "withdraw", args: [] });
  const out = classifyError(err);
  assert.equal(out.kind, "reverted");
  assert.match(out.message, /still locked/);
});

test("classifyError: unknown errors keep only the first line", () => {
  const out = classifyError(new Error("boom\nstack details"));
  assert.deepEqual(out, { kind: "unknown", message: "boom" });
});

test("validateTaskText: counts bytes like the contract (emoji = 4 bytes)", () => {
  assert.equal(validateTaskText("  ").ok, false);
  assert.equal(validateTaskText("a".repeat(280)).ok, true);
  assert.equal(validateTaskText("a".repeat(281)).ok, false);
  assert.equal(validateTaskText("\u{1F600}".repeat(70)).ok, true);  // 70 emoji = 280 bytes
  assert.equal(validateTaskText("\u{1F600}".repeat(71)).ok, false); // 71 emoji = 284 bytes: too long
  assert.equal(validateTaskText("नमस्ते").value, "नमस्ते");
});

test("parseDeposit: amounts and lock days", () => {
  const now = 1_800_000_000;
  const ok = parseDeposit({ amount: "1.5", days: "30", hasBank: false, nowSeconds: now });
  assert.equal(ok.ok, true);
  assert.equal(ok.wei, 1_500_000_000_000_000_000n);
  assert.equal(ok.unlockAt, BigInt(now + 30 * 86400));
  assert.equal(parseDeposit({ amount: "2", days: "x", hasBank: true, nowSeconds: now }).unlockAt, 0n); // top-up keeps date
  for (const bad of ["", "0", "-1", "1e3", "abc", "1.", ".5", "0.0000000000000000001", "1,5"]) {
    assert.equal(parseDeposit({ amount: bad, days: "30", hasBank: false, nowSeconds: now }).ok, false, bad);
  }
  for (const badDays of ["0", "3651", "1.5", "-3", ""]) {
    assert.equal(parseDeposit({ amount: "1", days: badDays, hasBank: false, nowSeconds: now }).ok, false, badDays);
  }
});

test("classifyError: cancelled, timed out and not-enough-ETH", () => {
  const cancelled = Object.assign(new Error("cancelled"), { name: "TransactionReplacedError", reason: "cancelled" });
  assert.equal(classifyError(cancelled).kind, "replaced");
  assert.match(classifyError(cancelled).message, /cancelled/);
  const replaced = Object.assign(new Error("replaced"), { name: "TransactionReplacedError", reason: "replaced" });
  assert.match(classifyError(replaced).message, /did not run/);
  assert.equal(classifyError(Object.assign(new Error("t"), { name: "WaitForTransactionReceiptTimeoutError" })).kind, "timeout");
  assert.equal(classifyError(new Error("Sender doesn't have enough funds to send tx.")).kind, "funds");
});
