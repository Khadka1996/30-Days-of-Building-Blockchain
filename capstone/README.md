# Capstone — Pramaan (प्रमाण): tamper-proof certificates for Nepal

Boards and universities publish a fingerprint of every certificate; an employer, agency or embassy anywhere checks one in seconds, for free. No personal data on-chain.

- **Design** (problem, users, what goes on-chain and why, security): [DESIGN.md](DESIGN.md)
- **Day 28** (design + contracts + tests): [day-28](../day-28)
- Day 29: web app, end-to-end tests, deploy kit · Day 30: self-audit and live demo

```bash
cd capstone
npm install
npm test               # 38 tests: contract, lib, fuzz
npm run demo           # 10,000-result batch, checks, a revocation and a stolen key
npm run planted-bugs   # 22 planted security bugs; the tests must catch all of them
npm run lint && npx hardhat compile && npm run slither
```
