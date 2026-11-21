import { createConfig, http, injected } from "wagmi";
import { hardhat } from "viem/chains";
import deployments from "./deployments.json";

// The one chain this app supports. Reads go straight to this RPC (not through
// the wallet), so what the page shows always comes from the right network.
export const APP_CHAIN = hardhat; // id 31337
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "http://127.0.0.1:8545";

if (deployments.chainId !== APP_CHAIN.id) {
  throw new Error(`deployments.json is for chain ${deployments.chainId}, app expects ${APP_CHAIN.id}`);
}

export const todoList = { ...deployments.contracts.TodoList, chainId: APP_CHAIN.id };
export const piggyBank = { ...deployments.contracts.PiggyBank, chainId: APP_CHAIN.id };

export const config = createConfig({
  chains: [APP_CHAIN],
  connectors: [injected()], // MetaMask, Rabby, Brave… whatever is in the browser
  transports: { [APP_CHAIN.id]: http(RPC_URL) },
  ssr: true,
});
