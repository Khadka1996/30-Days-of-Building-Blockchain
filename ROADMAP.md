# 30 Days of Building Blockchain — Detailed Roadmap

One small, complete, tested project every day, from very simple to complex. Each day builds on the days before it.

**Every day includes:** working code · tests · a security review (bugs found → fixed → proven with a test) · a short README in plain words · a LinkedIn post.

**Difficulty:** 🟢 easy · 🟡 medium · 🟠 hard · 🔴 advanced

---

## Week 1 — Solidity building blocks 🟢 (Days 1–7)

Goal: write small contracts with confidence: storage, access control, sending ETH safely, and time.

| Day | Project | What I build | New skills | Security focus |
|----:|---------|--------------|------------|----------------|
| 01 | **To-do list** | Add, complete and delete tasks; each user has a private list | Structs, arrays, mappings, events, first tests | Only the owner can edit a list |
| 02 | **Piggy bank with a time lock** | Deposit ETH; withdraw only after an unlock date | `block.timestamp`, payable functions, sending ETH | Safe withdrawals (checks → effects → interaction) |
| 03 | **Voting app** | Create a poll, one vote per address, show the winner | Enums, modifiers, deadlines | Double voting, voting after the deadline |
| 04 | **Multisig wallet** | 3 owners; any payment needs 2 approvals | Proposals, approvals, executing calls | Replay, approving twice, removed owners |
| 05 | **Escrow** | Buyer pays into escrow; released on delivery or refunded on dispute | State machines, a neutral arbiter | Stuck funds, wrong person releasing |
| 06 | **Crowdfunding** | Set a goal and a deadline; creator claims if met, backers refunded if not | Goals, deadlines, pull-payment refunds | Refund loops, claiming twice |
| 07 | **Week 1 recap + deploy kit** | Review all six; a ready deploy script and Etherscan verification for Sepolia | Deploy scripts, verification, `.env` secrets | Review of the whole week |

## Week 2 — Tokens and NFTs as products 🟡 (Days 8–14)

Goal: use the token standards to build things people actually use.

| Day | Project | What I build | New skills | Security focus |
|----:|---------|--------------|------------|----------------|
| 08 | **My own token + faucet** | An ERC-20 token and a faucet that gives a little to each address once a day | OpenZeppelin ERC-20, rate limits | Faucet draining with many addresses |
| 09 | **Token vesting** | Team tokens unlock slowly over 12 months, with a cliff | Linear vesting maths, time | Rounding errors, early claims |
| 10 | **Airdrop with Merkle proofs** | 1,000 addresses can claim; only one root stored on-chain | Merkle trees, proof verification | Claiming twice, fake proofs |
| 11 | **NFT collection** | Mint with an allowlist, a public sale and a max supply | ERC-721, metadata, allowlists | Minting past the limit, bots |
| 12 | **NFT marketplace** | List, buy and cancel NFTs; the creator gets a royalty | Approvals, ERC-2981 royalties | Selling NFTs you no longer own |
| 13 | **Auction** | English (rising bids) and Dutch (falling price) auctions | Bidding logic, refunds | Front-running, refund denial-of-service |
| 14 | **DAO** | Members vote with tokens; passed proposals run after a delay | Governor, timelock, voting power | Flash-loan voting, proposal spam |

## Week 3 — DeFi 🟠 (Days 15–21)

Goal: understand how money apps work by building small, simplified versions of them. These are teaching versions, not production code; each README says what a real protocol adds.

| Day | Project | What I build | New skills | Security focus |
|----:|---------|--------------|------------|----------------|
| 15 | **Staking with rewards** | Lock tokens, earn rewards per second | Reward-per-token maths | Reward rounding, staking just before payout |
| 16 | **Mini lending pool** | Deposit to earn interest; borrow against collateral; liquidations | Collateral ratios, interest rates | Bad debt, price manipulation |
| 17 | **Swap with a router** | A swap pool plus a router that finds the path A → B → C | AMM maths, multi-hop swaps | Slippage, sandwich attacks |
| 18 | **Flash loans** | Borrow and repay in one transaction; an arbitrage example | ERC-3156, callbacks | Using flash loans to attack other contracts |
| 19 | **Mini stablecoin** | Lock ETH, mint a dollar-pegged coin, get liquidated if it falls too low | Price oracles, over-collateralisation | Stale prices, depeg |
| 20 | **Yield vault** | Deposit tokens; the vault invests them and shares the profit | ERC-4626 shares | The first-depositor inflation attack |
| 21 | **Security & upgrades day** | Attack all of Week 3 with fuzz and invariant tests; upgrade one contract safely with a UUPS proxy | Fuzzing (fast-check), invariants, UUPS proxies | Everything from the week, storage layout clashes |

## Week 4 — Full-stack dApps 🔴 (Days 22–27)

Goal: turn contracts into real apps people can use in a browser.

| Day | Project | What I build | New skills | Security focus |
|----:|---------|--------------|------------|----------------|
| 22 | **Next.js dApp** | A web front end for the Week 1 contracts with wallet connect | Next.js, wagmi, viem | Wrong network, rejected transactions |
| 23 | **Reading events** | A live activity feed and simple indexer | Event logs, filters, indexing | Chain reorganisations, missed events |
| 24 | **Sign in with Ethereum** | Log in with a wallet instead of a password | EIP-4361, signatures, sessions | Signature replay, phishing |
| 25 | **Gasless transactions** | Users act without holding ETH; a relayer pays the gas | EIP-712 signed messages, meta-transactions | Relayer abuse, nonce reuse |
| 26 | **Layer 2 & cross-chain** | Two local chains: compare costs on an L2-style chain and send a message between them | L2 gas model, cross-chain messaging | Replay across chains, bridge risks |
| 27 | **Monitoring & alerts** | A dashboard that watches a contract and flags unusual activity | Event monitoring, alert rules | Admin key misuse, unusual withdrawals |

## Days 28–30 — Capstone ⭐

| Day | Project | What I build |
|----:|---------|--------------|
| 28 | **Capstone, part 1** | Design and smart contracts for a dApp that solves a real problem in Nepal, with full tests |
| 29 | **Capstone, part 2** | The web app, end-to-end tests and a deploy kit |
| 30 | **Capstone, part 3** | Full self-audit report, a live demo on a test network, and the 30-day wrap-up |

---

## How it runs

- **Built and tested automatically every day** on a local blockchain (Hardhat), so every result is real and repeatable.
- **Live test-network deployments are done by me from my own laptop** (Days 7 and 30, and any other day I choose), using a test-only wallet with free faucet ETH. No real money, and no private keys in the repository.
- **Foundry:** I practise it on my own machine; the daily automated runs use Hardhat with fast-check fuzzing.

## What I will have after 30 days

- **27 working projects** plus **one capstone app**, each tested and reviewed
- New skills: **wagmi / viem**, **Next.js dApps**, **DeFi maths**, **fuzz and invariant testing**, **upgradeable contracts**, **Layer 2 and cross-chain basics**
- Contracts deployed and verified on a test network
- A complete PDF guide of all 30 days

Part 1 (learning the concepts): [Learning Blockchain in 15 Days](https://github.com/Khadka1996/Learning-Blockchain)
