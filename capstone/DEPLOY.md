# Pramaan — deploy kit (Sepolia test network)

Run these from **your own laptop** with a **test-only wallet** (free faucet ETH, no real money). Nothing here was deployed by the automated daily run: public networks are blocked there, so every step was dry-run on a local Hardhat node instead (`npx hardhat node` + `--network localhost`).

## 0. What you need

- Node.js 20+ and this repo: `cd capstone && npm install`
- A **new** MetaMask account used only for testing, with ~0.05 Sepolia ETH from a faucet
- A Sepolia RPC URL (Infura, Alchemy or another provider) and an Etherscan API key
- For the council: a Safe multisig on Sepolia (2-of-3, [app.safe.global](https://app.safe.global)). For a quick demo you may use the deployer wallet as the council

## 1. Settings

```bash
cp .env.example .env      # .env is git-ignored: never commit it
```

Fill in `SEPOLIA_RPC_URL`, `DEPLOYER_PRIVATE_KEY` (the test wallet), `ETHERSCAN_API_KEY`, `COUNCIL_ADDRESS`, `APP_RPC_URL` (the read-only RPC verifiers' browsers will use; a public one is fine, see section 6) and `SITE_URL` (where the app will be hosted; it goes into every QR link).

## 2. Test, then deploy the contract

```bash
npm test                         # 58 tests must pass first
npm run deploy:sepolia           # deploys, waits 3 blocks
```

This writes `deployments/sepolia.json` (address, council, tx) and `app/public/config.json` (what the web app reads). If the council is a plain wallet, the script warns you. That is fine for a demo, not for production.

## 3. Verify the source on Etherscan

```bash
npx hardhat verify --network sepolia <PRAMAAN_ADDRESS> <COUNCIL_ADDRESS>
```

(The deploy script prints this exact line.) Afterwards the contract page shows a green tick and anyone can read the code.

## 4. Register the institutions (council)

```bash
ACTION=add-issuer ISSUER_KEY=0x… ISSUER_NAME="National Examinations Board" npm run council -- --network sepolia
```

- If the deployer **is** the council, the script simulates the call first (so it fails with the reason, before any gas is spent) and then sends it.
- If the council is a **Safe**, the script prints `{ to, value, data }`. Paste it into the Safe's Transaction Builder; two of three owners sign.
- Other actions: `ACTION=suspend|reinstate ISSUER_ID=2`, `ACTION=rotate ISSUER_ID=1 ISSUER_KEY=0xNEW`, `ACTION=compromise ISSUER_ID=1 SINCE=<unix time> ISSUER_KEY=0xNEW`.

Each institution key should be a separate wallet (ideally a hardware wallet), never the council's key: the contract refuses it.

## 5. Build and host the web app

The app is **static files**: no server, no database.

```bash
npm run build:app                # bundles app/src → app/public/build
```

Upload the whole `app/public/` folder (with `config.json`) to any static host: GitHub Pages, Netlify, Vercel or an institution's own web server. Set these response headers (the local server in `app/server.js` uses the same):

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' <APP_RPC_URL origin>; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
```

Use HTTPS and a domain people can recognise; print that domain on the certificate next to the QR code ("check at pramaan.example.np").

## 6. Try the full story

1. Open `https://<site>/portal.html`, connect MetaMask with an institution key on Sepolia.
2. Upload `app/sample/see-2081-sample.csv` (fictional students), **download the backup**, publish. One transaction for the whole file.
3. Download the certificate pack. Open a `verifyLink` on your phone → **VALID**.
4. Change one letter in a link's data, or revoke a certificate from the portal, and check again → **NOT FOUND** / **REVOKED**.

**About the RPC.** Verifiers trust the RPC in `config.json` to answer honestly. A public RPC is fine for a demo; in production, the institutions run their own nodes (the permissioned network in DESIGN.md) and point the site at them.

## 7. Safety checklist

- [ ] `.env` is not in `git status`
- [ ] The deployer wallet is test-only and holds no real funds
- [ ] `deployments/sepolia.json` and the Etherscan link are saved
- [ ] The backup JSON files (they contain every salt) are kept offline, not emailed
- [ ] The CSP header is set on the host (check with your browser's dev tools)
