// Pure safety checks used by the UI. No React, no wallet: easy to unit test.
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, parseEther } from "viem";

export const MAX_TASK_BYTES = 280; // TodoList.MAX_TEXT_LENGTH
export const MAX_LOCK_DAYS = 3650; // PiggyBank.MAX_LOCK_DURATION (10 years)

/** Is the wallet on the chain our contracts live on? */
export function checkNetwork(walletChainId, expectedChainId) {
  if (walletChainId === undefined || walletChainId === null) {
    return { ok: false, message: "Could not read your wallet's network." };
  }
  if (Number(walletChainId) !== Number(expectedChainId)) {
    return {
      ok: false,
      message: `Wrong network: your wallet is on chain ${Number(walletChainId)}. This app only works on Hardhat Local (chain ${expectedChainId}).`,
    };
  }
  return { ok: true, message: "" };
}

// Plain-words messages for the contracts' custom errors.
const REVERT_MESSAGES = {
  EmptyText: "A task needs some text.",
  TextTooLong: `Task is too long (max ${MAX_TASK_BYTES} bytes).`,
  TooManyTasks: "Your list is full (100 tasks). Delete one first.",
  TaskNotFound: "That task no longer exists. The list has been refreshed.",
  AlreadyCompleted: "That task is already done.",
  ZeroDeposit: "Enter an amount above 0.",
  UnlockNotInFuture: "The unlock date must be in the future.",
  LockTooLong: "The lock can be at most 10 years.",
  LockAlreadySet: "Your piggy bank already has an unlock date. Add money without changing it.",
  StillLocked: "Your piggy bank is still locked. Wait until the unlock date.",
  NothingToWithdraw: "Your piggy bank is empty.",
  TransferFailed: "Sending the ETH back failed.",
};

/**
 * Turn any wallet / RPC / contract error into { kind, message } a person can read.
 * kind: "rejected" | "wrong-network" | "replaced" | "timeout" | "funds" | "reverted" | "unknown"
 */
export function classifyError(err) {
  if (!err) return { kind: "unknown", message: "Something went wrong." };

  // Search the whole cause chain: libraries wrap errors several levels deep.
  const chain = [];
  for (let e = err, i = 0; e && i < 10; e = e.cause, i++) chain.push(e);
  const has = (pred) => chain.some((e) => { try { return pred(e); } catch { return false; } });

  // 1. The person clicked "Reject" in their wallet (EIP-1193 code 4001).
  if (has((e) => e instanceof UserRejectedRequestError || e.code === 4001 || e.name === "UserRejectedRequestError")) {
    return { kind: "rejected", message: "You rejected the request in your wallet. Nothing was sent and nothing changed." };
  }

  // 2. Wallet and app disagree about the network.
  if (has((e) => /ChainMismatch|ChainNotConfigured|WrongNetwork/.test(e.name || "") || e.code === 4902)) {
    return { kind: "wrong-network", message: "Your wallet is on the wrong network. Switch to Hardhat Local and try again." };
  }

  // 3. Cancelled or replaced from the wallet, after it was sent.
  const replaced = chain.find((e) => e.name === "TransactionReplacedError");
  if (replaced) {
    return { kind: "replaced", message: replaced.reason === "cancelled"
      ? "The transaction was cancelled in your wallet before it ran. Nothing changed."
      : "Another transaction replaced this one in your wallet, so this action did not run." };
  }

  // 4. Sent, but no block included it in time (dropped, or fee too low).
  if (has((e) => e.name === "WaitForTransactionReceiptTimeoutError")) {
    return { kind: "timeout", message: "Not confirmed in time. It may have been dropped: check your wallet's activity before trying again." };
  }

  // 5. Not enough ETH for the amount + gas.
  if (has((e) => e.name === "InsufficientFundsError" || /insufficient funds|enough funds|exceeds the balance/i.test(e.shortMessage || e.message || ""))) {
    return { kind: "funds", message: "Your wallet does not have enough ETH for this amount plus the network fee." };
  }

  // 6. The contract said no (found by simulation, before the wallet is asked).
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert) {
      const name = revert.data?.errorName;
      return { kind: "reverted", message: REVERT_MESSAGES[name] || `The contract refused: ${name || revert.reason || "unknown reason"}.` };
    }
  }
  return { kind: "unknown", message: (err.shortMessage || err.message || "Something went wrong.").split("\n")[0] };
}

/** Check task text the same way the contract will (length in BYTES, not letters). */
export function validateTaskText(text) {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return { ok: false, message: "Write something first." };
  const bytes = new TextEncoder().encode(trimmed).length;
  if (bytes > MAX_TASK_BYTES) return { ok: false, message: `Too long: ${bytes} bytes (max ${MAX_TASK_BYTES}).` };
  return { ok: true, value: trimmed, message: "" };
}

/**
 * Check a piggy bank deposit form. Returns wei + the unlockAt the contract expects
 * (a future timestamp for a new bank, 0 to top up an existing one).
 */
export function parseDeposit({ amount, days, hasBank, nowSeconds }) {
  const a = String(amount ?? "").trim();
  if (!/^\d+(\.\d{1,18})?$/.test(a)) return { ok: false, message: "Enter an amount like 0.5 (max 18 decimals)." };
  const wei = parseEther(a);
  if (wei <= 0n) return { ok: false, message: "Enter an amount above 0." };
  if (hasBank) return { ok: true, wei, unlockAt: 0n, message: "" };

  const d = String(days ?? "").trim();
  if (!/^\d+$/.test(d) || Number(d) < 1 || Number(d) > MAX_LOCK_DAYS) {
    return { ok: false, message: `Lock for a whole number of days, 1 to ${MAX_LOCK_DAYS}.` };
  }
  return { ok: true, wei, unlockAt: BigInt(Math.floor(nowSeconds)) + BigInt(d) * 86400n, message: "" };
}

export const shortAddress = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
