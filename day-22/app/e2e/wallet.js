// A fake browser wallet for tests: a real EIP-1193 provider at window.ethereum
// (what MetaMask injects), with switches to play the "bad day" cases:
//   __wallet.setChain("0x1")            wallet moves to Ethereum mainnet (emits chainChanged)
//   __wallet.setChain("0x1", true)       ...silently, without telling the app
//   __wallet.setReject(true)             every transaction pop-up is "Rejected"
//   __wallet.setRejectSwitch(true)       the "switch network" pop-up is "Rejected"
//   __wallet.sent                        every eth_sendTransaction the app asked for
// Everything else is forwarded to the local Hardhat node, which signs with its
// unlocked test account. No private key is involved.
import { rpc } from "./rpc.js";

export const ACCOUNT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // Hardhat test account #1

export async function installWallet(page, { chainId = "0x7a69", rejectConnect = false } = {}) {
  await page.exposeFunction("__walletRpc", async (method, params) => {
    try { return { result: await rpc(method, params) }; } catch (e) { return { error: { code: e.code, message: e.message, data: e.data } }; }
  });
  await page.addInitScript(({ account, chainId, rejectConnect }) => {
    const listeners = {};
    const emit = (ev, v) => (listeners[ev] || []).forEach((fn) => fn(v));
    const state = { chainId, accounts: [], reject: false, rejectSwitch: false, rejectConnect, sent: [] };
    const rejected = () => Object.assign(new Error("User rejected the request."), { code: 4001 });

    const provider = {
      isTestWallet: true,
      on: (ev, fn) => ((listeners[ev] ||= []).push(fn), provider),
      removeListener: (ev, fn) => ((listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn)), provider),
      async request({ method, params = [] }) {
        switch (method) {
          case "eth_requestAccounts":
            if (state.rejectConnect) throw rejected();
            state.accounts = [account];
            emit("accountsChanged", state.accounts);
            return state.accounts;
          case "eth_accounts": return state.accounts;
          case "eth_chainId": return state.chainId;
          case "net_version": return String(parseInt(state.chainId, 16));
          case "wallet_requestPermissions": case "wallet_revokePermissions":
            if (method === "wallet_revokePermissions") state.accounts = [];
            return [{ parentCapability: "eth_accounts" }];
          case "wallet_switchEthereumChain": {
            if (state.rejectSwitch) throw rejected();
            const target = params[0]?.chainId;
            if (target !== "0x7a69") throw Object.assign(new Error("Unrecognized chain"), { code: 4902 });
            state.chainId = target;
            emit("chainChanged", target);
            return null;
          }
          case "eth_sendTransaction":
            state.sent.push({ chainId: state.chainId, tx: params[0] });
            if (state.reject) throw rejected();
            break;
        }
        const res = await window.__walletRpc(method, params);
        if (res.error) throw Object.assign(new Error(res.error.message), res.error);
        return res.result;
      },
    };
    window.ethereum = provider;
    window.__wallet = {
      get sent() { return state.sent; },
      setReject: (v) => { state.reject = v; },
      setRejectSwitch: (v) => { state.rejectSwitch = v; },
      setChain: (id, silent = false) => { state.chainId = id; if (!silent) emit("chainChanged", id); },
    };
  }, { account: ACCOUNT, chainId, rejectConnect });
}
