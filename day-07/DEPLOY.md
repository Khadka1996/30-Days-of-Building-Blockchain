# Deploying Week 1 to Sepolia — step by step

This puts all six Week 1 contracts on the **Sepolia test network** and verifies them on Etherscan. Sepolia ETH is free and has no value. Run it from your own laptop; it takes about 15 minutes.

> **Safety first.** Use a **brand-new wallet made only for testing**. Never use a wallet that holds real money, and never paste a private key into any file except `.env` (which git ignores). The kit refuses every network except Sepolia and the local Hardhat chain.

## 1. What you need

- Node.js 18 or newer, and this repository cloned
- A **test-only wallet** (in MetaMask: *Add account* → a new account used for nothing else) and its private key
- About **0.05 Sepolia ETH** in that wallet, from a faucet such as the [Google Cloud Sepolia faucet](https://cloud.google.com/application/web3/faucet/ethereum/sepolia) or the [Alchemy Sepolia faucet](https://www.alchemy.com/faucets/ethereum-sepolia). The whole deployment uses 10,051,136 gas (about 0.02 ETH at 2 gwei)
- A Sepolia **RPC URL** (free account at [Alchemy](https://www.alchemy.com/) or [Infura](https://www.infura.io/))
- An **Etherscan API key** ([etherscan.io → API Keys](https://etherscan.io/myapikey))
- The **three owner addresses** for the Day 04 multisig (for example three of your own test accounts)

## 2. Install and rehearse locally

```bash
cd 30-Days-of-Building-Blockchain/day-07
npm install --legacy-peer-deps
npm test          # 21 tests must pass
npm run demo      # full rehearsal on the local chain: refusals, deploy, resume, check
```

## 3. Fill in `.env`

```bash
cp .env.example .env
```

Open `.env` and set:

| Name | Value |
|------|-------|
| `SEPOLIA_RPC_URL` | your Alchemy / Infura Sepolia URL |
| `PRIVATE_KEY` | the test-only wallet's key: `0x` + 64 hex characters |
| `ETHERSCAN_API_KEY` | your Etherscan key |
| `MULTISIG_OWNERS` | three addresses, separated by commas, no spaces needed |
| `MULTISIG_THRESHOLD` | `2` |

Check that git cannot see it: `git status` must **not** list `.env`.

## 4. Deploy

```bash
npm run deploy:sepolia
```

The script first prints the network, your balance and the estimated cost, and stops **before sending anything** if the network, the settings or the balance are wrong. Then it deploys the six contracts one by one, waiting 5 confirmations each, and saves every address to `deployments/sepolia.json` as it goes.

**If it stops half-way** (network error, closed laptop), just run the same command again: contracts already on-chain are skipped, so you never pay twice.

## 5. Verify on Etherscan

```bash
npm run verify:sepolia
```

Each contract prints `verified` (or `already verified` if you run it again). The script also printed the same commands for one-by-one use, for example:

```bash
npx hardhat verify --network sepolia <TodoList address>
npx hardhat verify --network sepolia --constructor-args deployments/sepolia.MultiSigWallet.args.js <MultiSigWallet address>
```

## 6. Check

```bash
npm run check:sepolia
```

Expect six ✓ lines and "the multisig settings match". Open each address on [sepolia.etherscan.io](https://sepolia.etherscan.io): the **Contract** tab should show a green tick and the source code.

## 7. After deploying

- Commit `deployments/sepolia.json` and `deployments/sepolia.MultiSigWallet.args.js` (addresses are public, they hold no secrets). **Never** commit `.env`.
- Add the Etherscan links to `day-07/README.md`.
- Keep the test wallet for Day 30, or empty it back to the faucet.

## If something goes wrong

| Message | What to do |
|---------|-----------|
| `Refusing to deploy to chain …` | Your RPC URL is not a Sepolia URL. |
| `PRIVATE_KEY must be 0x followed by 64 hex characters` | Copy the key again; add `0x` at the start if it is missing. |
| `Set BOTH SEPOLIA_RPC_URL and PRIVATE_KEY` | One of the two lines in `.env` is empty. |
| `Not enough ETH … Nothing was sent` | Get more Sepolia ETH from a faucet and run again. |
| `… was deployed with different settings` | You changed `MULTISIG_OWNERS` after a deploy. Move `deployments/sepolia.json` away to start fresh, or restore the old owners. |
| `verify` says the bytecode does not match | Do not change `hardhat.config.js` compiler settings between deploy and verify. |
