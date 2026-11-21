"use client";
import { useBytecode, useChainId, useConnection, useSwitchChain } from "wagmi";
import { APP_CHAIN, piggyBank, todoList } from "../lib/wagmi";
import { checkNetwork, classifyError } from "../lib/guards";

/** Blocks every write unless the wallet is on our chain AND our contracts exist there. */
export default function NetworkGuard({ children }) {
  const { chainId } = useConnection();          // the wallet's chain
  const appChainId = useChainId();             // the chain our config reads from
  const { switchChain, isPending, error } = useSwitchChain();
  const todoCode = useBytecode({ address: todoList.address, chainId: APP_CHAIN.id });
  const piggyCode = useBytecode({ address: piggyBank.address, chainId: APP_CHAIN.id });

  const net = checkNetwork(chainId, APP_CHAIN.id);
  const deployed = Boolean(todoCode.data && todoCode.data !== "0x" && piggyCode.data && piggyCode.data !== "0x");
  const checking = todoCode.isLoading || piggyCode.isLoading;

  return (
    <>
      {!net.ok && (
        <section className="banner" role="alert" data-testid="wrong-network">
          <p>{net.message}</p>
          <button onClick={() => switchChain({ chainId: appChainId })} disabled={isPending}>
            {isPending ? "Confirm in your wallet…" : `Switch to ${APP_CHAIN.name}`}
          </button>
          {error && <p className="error">{classifyError(error).message}</p>}
        </section>
      )}
      {net.ok && !checking && !deployed && (
        <section className="banner" role="alert" data-testid="not-deployed">
          <p>The contracts are not on this chain. Start the node and run <code>npm run deploy</code>.</p>
        </section>
      )}
      {children(net.ok && deployed)}
    </>
  );
}
