"use client";
import { useConnect, useConnection, useConnectors, useDisconnect } from "wagmi";
import { classifyError, shortAddress } from "../lib/guards";

export default function WalletBar() {
  const { address, isConnected } = useConnection();
  const connectors = useConnectors();
  const { connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected) {
    return (
      <div className="wallet">
        <span className="pill" data-testid="account">{shortAddress(address)}</span>
        <button className="ghost" onClick={() => disconnect()}>Disconnect</button>
      </div>
    );
  }
  const injected = connectors[0];
  return (
    <div className="wallet">
      <button onClick={() => connect({ connector: injected })} disabled={isPending} data-testid="connect">
        {isPending ? "Check your wallet…" : "Connect wallet"}
      </button>
      {error && <p className="error" role="alert">{classifyError(error).message}</p>}
    </div>
  );
}
