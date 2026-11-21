"use client";
import { useConnection } from "wagmi";
import WalletBar from "../components/WalletBar";
import NetworkGuard from "../components/NetworkGuard";
import TodoPanel from "../components/TodoPanel";
import PiggyPanel from "../components/PiggyPanel";

export default function Home() {
  const { isConnected } = useConnection();
  return (
    <main>
      <header>
        <div>
          <h1>Week 1 dApp</h1>
          <p className="muted">Day 1 to-do list + Day 2 piggy bank, now with a real web front end.</p>
        </div>
        <WalletBar />
      </header>
      {isConnected ? (
        <NetworkGuard>
          {(canWrite) => (
            <div className="grid">
              <TodoPanel canWrite={canWrite} />
              <PiggyPanel canWrite={canWrite} />
            </div>
          )}
        </NetworkGuard>
      ) : (
        <section className="card center">
          <h2>Connect your wallet to start</h2>
          <p className="muted">Your wallet signs each action. This page never sees your private key.</p>
        </section>
      )}
    </main>
  );
}
