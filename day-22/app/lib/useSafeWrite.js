"use client";
import { useRef, useState } from "react";
import { useConnection, useConfig } from "wagmi";
import { getBalance, simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { useQueryClient } from "@tanstack/react-query";
import { APP_CHAIN } from "./wagmi";
import { checkNetwork, classifyError } from "./guards";

// Stop waiting after this long (a dropped transaction would otherwise spin forever).
export const TX_TIMEOUT_MS = Number(process.env.NEXT_PUBLIC_TX_TIMEOUT_MS) || 120_000;

/**
 * Every write in the app goes through here, in 4 steps:
 *   1. ask the WALLET which network it is on right now (not a cached value)
 *   2. simulate the call on our own RPC: a revert is shown before any wallet pop-up
 *   3. send it, pinned to our chain id (wagmi checks the wallet chain again)
 *   4. wait for the receipt and check it really succeeded: not cancelled or
 *      replaced from the wallet, and not stuck forever if it is dropped
 * Any failure (rejected, wrong network, revert) ends in a clear message and the
 * buttons unlock again: the UI is never stuck on "waiting".
 */
export function useSafeWrite() {
  const config = useConfig();
  const queryClient = useQueryClient();
  const { address, connector } = useConnection();
  const [tx, setTx] = useState({ status: "idle" });
  const inFlight = useRef(false); // blocks double clicks even before React re-renders

  /** onSuccess runs only when the transaction is confirmed and really ran. */
  async function send({ contract, functionName, args = [], value, label, onSuccess }) {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setTx({ status: "checking", label });
      if (!connector || !address) throw Object.assign(new Error("Connect a wallet first."), { name: "NotConnected" });

      // 1. Live network check, straight from the wallet.
      const net = checkNetwork(await connector.getChainId(), APP_CHAIN.id);
      if (!net.ok) throw Object.assign(new Error(net.message), { name: "WrongNetworkError" });

      // 2. Enough ETH? (A dry run does NOT check this: it would happily "succeed"
      //    and the wallet would pop up for a payment that can never go through.)
      if (value) {
        const { value: balance } = await getBalance(config, { address, chainId: APP_CHAIN.id });
        if (balance < value) throw Object.assign(new Error("insufficient funds"), { name: "InsufficientFundsError" });
      }
      //    Dry run on the app's RPC with the user's address.
      const { request } = await simulateContract(config, {
        address: contract.address, abi: contract.abi, functionName, args, value,
        account: address, chainId: APP_CHAIN.id,
      });

      // 3. Ask the wallet to sign + send.
      setTx({ status: "wallet", label });
      const hash = await writeContract(config, { ...request, chainId: APP_CHAIN.id });

      // 4. Wait for it to be mined and check the result.
      setTx({ status: "pending", label, hash });
      let replaced = null;
      const receipt = await waitForTransactionReceipt(config, {
        hash, chainId: APP_CHAIN.id, timeout: TX_TIMEOUT_MS, pollingInterval: 1_000,
        onReplaced: (r) => { replaced = r; },
      });
      // "Speed up" (repriced) is the same action with a higher fee: fine.
      // "Cancel" or a different transaction with the same nonce: OUR action never ran.
      if (replaced && replaced.reason !== "repriced") {
        throw Object.assign(new Error(replaced.reason), { name: "TransactionReplacedError", reason: replaced.reason });
      }
      if (receipt.status !== "success") throw new Error("The transaction failed on-chain.");
      setTx({ status: "success", label, hash });
      onSuccess?.(); // same render as "Done": nothing the user types next is wiped
    } catch (err) {
      const { kind, message } = err?.name === "NotConnected" ? { kind: "unknown", message: err.message } : classifyError(err);
      setTx({ status: "error", kind, message, label });
    } finally {
      inFlight.current = false;
      await queryClient.invalidateQueries(); // re-read the chain whatever happened
    }
  }

  const busy = ["checking", "wallet", "pending"].includes(tx.status);
  return { send, tx, busy, reset: () => setTx({ status: "idle" }) };
}
