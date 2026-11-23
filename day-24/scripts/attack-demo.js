// `npm run demo`: one real sign-in, then 8 attacks against it, on the in-process
// Hardhat chain. Prints what the server answered each time.
const { ethers } = require("hardhat");
const h = require("../test/helpers");

async function main() {
  const env = await h.deploy();
  await env.todo.addTask("Buy momo for the team");
  const app = await h.startServer(env);
  const [alice, walletOwner, mallory] = env.signers;
  const rows = [];
  const row = (what, r) => rows.push([what, r.status, r.status === 200 ? `signed in as ${r.json.address.slice(0, 10)}…` : r.json.error]);

  const browser = new h.Browser(app.base);
  const first = await h.signIn(app, browser, alice);
  row("Alice signs in (normal wallet)", first.res);
  row("Smart wallet signs in (ERC-1271)", (await h.signIn(app, new h.Browser(app.base), walletOwner, {}, await env.wallet.getAddress())).res);

  await browser.logout();
  row("Replay Alice's signature", await browser.login(first.message, first.signature));

  const { json } = await browser.nonce();
  const msg = h.buildMessage(app, alice.address, json.nonce);
  const sig = await alice.signMessage(msg);
  const thief = new h.Browser(app.base);
  await thief.nonce();
  row("Mallory uses a stolen signature", await thief.login(msg, sig));
  row("Phishing-site signature (evil.example)", (await h.signIn(app, new h.Browser(app.base), alice, { domain: "evil.example", uri: "https://evil.example" })).res);
  row("Message for another chain (ID 1)", (await h.signIn(app, new h.Browser(app.base), alice, { chainId: 1 })).res);
  const b2 = new h.Browser(app.base);
  const n2 = (await b2.nonce()).json.nonce;
  const smuggled = h.buildMessage(app, alice.address, n2) + "\nNonce: aaaaaaaaaaaaaaaa";
  row("Smuggled 2nd 'Nonce:' line", await b2.login(smuggled, await alice.signMessage(smuggled)));
  const b3 = new h.Browser(app.base);
  const n3 = (await b3.nonce()).json.nonce;
  const m3 = h.buildMessage(app, alice.address, n3);
  row("Mallory signs as Alice with her own key", await b3.login(m3, await mallory.signMessage(m3)));
  const b4 = new h.Browser(app.base);
  const n4 = (await b4.nonce()).json.nonce;
  const m4 = h.buildMessage(app, alice.address, n4);
  row("Login posted from another site", await b4.login(m4, await alice.signMessage(m4), { headers: { origin: "https://evil.example" } }));

  for (const [what, status, note] of rows) console.log(`${what.padEnd(42)} ${String(status).padEnd(4)} ${note}`);
  const blocked = rows.slice(2).filter((r) => r[1] !== 200).length;
  console.log(`\n2 real sign-ins accepted · ${blocked} of ${rows.length - 2} attacks refused`);
  await app.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
