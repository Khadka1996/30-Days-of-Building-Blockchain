# 30 Days of Building Blockchain

Part 2 of my blockchain journey. In [Part 1 — Learning Blockchain in 15 Days](https://github.com/Khadka1996/Learning-Blockchain) I learned the concepts, from a single hash to a full-stack dApp ([free 84-page study guide](https://github.com/Khadka1996/Learning-Blockchain/tree/main/guide)).

Now I **build**: one small, complete, tested project every day for 30 days, going from very simple to complex.

**Author:** [Manish Khadka](https://khadka-manish.com.np) · [LinkedIn](https://www.linkedin.com/in/manishkhadka1996) · [GitHub](https://github.com/Khadka1996)

---

## How every day works

1. **Build:** one focused project with clean, commented code.
2. **Test:** unit tests, plus fuzz and invariant tests where they matter.
3. **Attack and fix:** a security review of the day's code; every bug found is fixed and proven with a test (`QA.md`).
4. **Share:** a short LinkedIn post at 5:30 pm Nepal time, explaining in simple words what I built.

## Roadmap

| Day | Project | Status |
|----:|---------|:------:|
| **Week 1 — Solidity building blocks** | | |
| 01 | To-do list on the blockchain | ⏳ |
| 02 | Piggy bank with a time lock | ⏳ |
| 03 | Voting app | ⏳ |
| 04 | Multisig wallet (2-of-3 approvals) | ⏳ |
| 05 | Escrow between a buyer and a seller | ⏳ |
| 06 | Crowdfunding with refunds | ⏳ |
| 07 | Week 1 recap: deploy and review everything | ⏳ |
| **Week 2 — Tokens and NFTs as products** | | |
| 08 | My own token with a faucet | ⏳ |
| 09 | Token vesting for a team | ⏳ |
| 10 | Airdrop with Merkle proofs | ⏳ |
| 11 | NFT collection with an allowlist | ⏳ |
| 12 | NFT marketplace | ⏳ |
| 13 | Auction (English and Dutch) | ⏳ |
| 14 | DAO: members vote with tokens | ⏳ |
| **Week 3 — DeFi** | | |
| 15 | Staking with rewards | ⏳ |
| 16 | Simple lending pool | ⏳ |
| 17 | Token swap with a router | ⏳ |
| 18 | Flash loans | ⏳ |
| 19 | A simple stablecoin | ⏳ |
| 20 | Yield vault (ERC-4626) | ⏳ |
| 21 | Security day: attacking Week 3 with Foundry | ⏳ |
| **Week 4 — Full-stack dApps** | | |
| 22 | Next.js dApp with wagmi / viem | ⏳ |
| 23 | Reading and indexing blockchain events | ⏳ |
| 24 | Sign in with Ethereum | ⏳ |
| 25 | Gasless transactions | ⏳ |
| 26 | Deploying to a Layer 2 test network | ⏳ |
| 27 | Cross-chain basics | ⏳ |
| 28 | Upgrades and monitoring a live contract | ⏳ |
| **Capstone** | | |
| 29 | Capstone, part 1: a dApp for a real Nepal problem | ⏳ |
| 30 | Capstone, part 2: audit, demo and wrap-up | ⏳ |

## Repository structure

```
30-Days-of-Building-Blockchain/
├── day-01/            # one folder per day
│   ├── README.md      # what I built, how it works, results
│   ├── contracts/     # Solidity
│   ├── test/          # tests
│   └── QA.md          # security review: bugs found → fixes
├── ...
└── tools/             # shared templates (LinkedIn card, post style)
```

## Tech stack

Solidity · Foundry · Hardhat · OpenZeppelin · Next.js · wagmi / viem · Sepolia and Layer 2 test networks (no real money)

## Follow along

A new project every day at 5:30 pm Nepal time on [LinkedIn](https://www.linkedin.com/in/manishkhadka1996).
