"use client";
const TEXT = {
  checking: "Checking network and simulating…",
  wallet: "Confirm in your wallet…",
  pending: "Sent. Waiting for the block…",
  success: "Done ✓",
};

export default function TxStatus({ tx }) {
  if (tx.status === "idle") return null;
  const cls = tx.status === "error" ? `status error ${tx.kind}` : `status ${tx.status}`;
  return (
    <p className={cls} role="status" data-testid="tx-status" data-kind={tx.kind || tx.status}>
      {tx.label ? <strong>{tx.label}: </strong> : null}
      {tx.status === "error" ? tx.message : TEXT[tx.status]}
    </p>
  );
}
