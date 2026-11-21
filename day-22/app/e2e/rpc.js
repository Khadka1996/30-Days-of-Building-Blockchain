// Tiny JSON-RPC client for the local Hardhat node (used from the Node side of tests).
export const RPC = "http://127.0.0.1:8545";
let id = 0;
export async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const body = await res.json();
  if (body.error) { const e = new Error(body.error.message); e.code = body.error.code; e.data = body.error.data; throw e; }
  return body.result;
}
