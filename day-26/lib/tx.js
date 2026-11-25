// Send a transaction from a local key and keep the signed bytes, so we can
// measure exactly what an L2 would have to post to L1.
async function sendRaw(wallet, txReq) {
  const populated = await wallet.populateTransaction(txReq);
  const raw = await wallet.signTransaction(populated);
  const resp = await wallet.provider.broadcastTransaction(raw);
  const receipt = await resp.wait();
  if (receipt.status !== 1) throw new Error("transaction reverted");
  return { raw, receipt };
}
module.exports = { sendRaw };
