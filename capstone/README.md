# Capstone — Pramaan (प्रमाण): tamper-proof certificates for Nepal

Boards and universities publish a fingerprint of every certificate; an employer, agency or embassy anywhere checks one in seconds, for free. No personal data on-chain.

- **Design** (problem, users, what goes on-chain and why, security): [DESIGN.md](DESIGN.md)
- **Day 28** (design + contracts + tests): [day-28](../day-28)
- **Day 29** (web app, end-to-end tests, deploy kit): [day-29](../day-29) · deploy to Sepolia: [DEPLOY.md](DEPLOY.md)
- Day 30: self-audit and live demo

```bash
cd capstone
npm install
npm test               # 58 tests: contract, lib, fuzz, app, end-to-end in Chromium
npm run app            # local chain + web app at http://127.0.0.1:4029
npm run demo           # contract story: 10,000-result batch, checks, a revocation and a stolen key
npm run planted-bugs   # 36 planted security bugs; the tests must catch all of them
npm run lint && npx hardhat compile && npm run slither
```

| Folder | What |
|---|---|
| [`contracts/`](contracts) | `Pramaan.sol`: council, institutions, issue, batches, revoke, verify, stolen-key windows |
| [`lib/`](lib) | how an institution makes `serial`, `docHash` and a batch tree |
| [`app/`](app) | the web app: verifier page, institution portal, QR payload + CSV (`src/`), static pages (`public/`), local server |
| [`scripts/`](scripts) | `app.js` (local stack), `deploy.js`, `council.js`, `demo.js`, `planted-bugs.py` |
| [`test/`](test) | contract, library, fuzz, app and Playwright end-to-end tests |
