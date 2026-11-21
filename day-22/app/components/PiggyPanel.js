"use client";
import { useState } from "react";
import { formatEther } from "viem";
import { useBalance, useBlock, useConnection, useReadContract } from "wagmi";
import { APP_CHAIN, piggyBank } from "../lib/wagmi";
import { parseDeposit } from "../lib/guards";
import { useSafeWrite } from "../lib/useSafeWrite";
import TxStatus from "./TxStatus";

export default function PiggyPanel({ canWrite }) {
  const { address } = useConnection();
  const [amount, setAmount] = useState("");
  const [days, setDays] = useState("30");
  const [formError, setFormError] = useState("");
  const { send, tx, busy } = useSafeWrite();
  const bank = useReadContract({ ...piggyBank, functionName: "getBank", args: [address], query: { enabled: !!address } });
  const wallet = useBalance({ address, chainId: APP_CHAIN.id });
  // Use the CHAIN's clock, not the browser's: the contract checks block.timestamp.
  const block = useBlock({ chainId: APP_CHAIN.id, watch: true });

  const [balance, unlockAt] = bank.data ?? [0n, 0n];
  const hasBank = balance > 0n;
  const now = block.data ? Number(block.data.timestamp) : 0;
  const unlocked = hasBank && now >= Number(unlockAt);
  const locked = !canWrite || busy || !block.data;

  async function onDeposit(e) {
    e.preventDefault();
    const p = parseDeposit({ amount, days, hasBank, nowSeconds: now });
    setFormError(p.message);
    if (!p.ok) return;
    await send({ contract: piggyBank, functionName: "deposit", args: [p.unlockAt], value: p.wei, label: "Deposit", onSuccess: () => setAmount("") });
  }

  return (
    <section className="card" aria-labelledby="piggy-h">
      <h2 id="piggy-h">🐷 Piggy bank <span className="muted small">Day 2</span></h2>
      <dl className="stats">
        <div><dt>Saved</dt><dd data-testid="saved">{formatEther(balance)} ETH</dd></div>
        <div><dt>Unlocks</dt><dd data-testid="unlock">{hasBank ? new Date(Number(unlockAt) * 1000).toISOString().slice(0, 10) : "—"}</dd></div>
        <div><dt>Wallet</dt><dd>{wallet.data ? Number(formatEther(wallet.data.value)).toFixed(2) : "…"} ETH</dd></div>
      </dl>
      <form onSubmit={onDeposit} className="row">
        <input aria-label="Amount in ETH" placeholder="Amount (ETH)" inputMode="decimal" value={amount}
          onChange={(e) => setAmount(e.target.value)} disabled={locked} />
        {!hasBank && (
          <input aria-label="Lock days" className="narrow" inputMode="numeric" value={days}
            onChange={(e) => setDays(e.target.value)} disabled={locked} title="Days to lock" />
        )}
        <button type="submit" disabled={locked} data-testid="deposit">{hasBank ? "Add" : "Lock"}</button>
      </form>
      {formError && <p className="error">{formError}</p>}
      <button className="wide" data-testid="withdraw" disabled={locked || !hasBank}
        onClick={() => send({ contract: piggyBank, functionName: "withdraw", label: "Withdraw" })}>
        {!hasBank ? "Nothing to withdraw" : unlocked ? "Withdraw all" : "Withdraw (still locked)"}
      </button>
      <TxStatus tx={tx} />
    </section>
  );
}
