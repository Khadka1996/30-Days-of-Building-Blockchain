# Tools

## Build setup (offline compiler)

`hardhat.config.template.js` compiles Solidity **offline** with the `solc` npm package (solcjs), so builds work where compiler downloads are blocked.

```bash
cd day-XX
npm init -y
npm i -D hardhat@2.22.17 solc@0.8.24 @nomicfoundation/hardhat-ethers@3 \
  @nomicfoundation/hardhat-chai-matchers@2 @nomicfoundation/hardhat-network-helpers@1 \
  chai@4 ethers@6 @openzeppelin/contracts@5.0.2 fast-check@3 --legacy-peer-deps
cp ../tools/hardhat.config.template.js hardhat.config.js
npx hardhat test
```

## Daily QA & security checklist
- `npx hardhat test`: all unit, fuzz and invariant tests green
- `npm audit --omit=dev`: no high or critical issues
- `npx solhint 'contracts/**/*.sol'`: Solidity lint
- `slither . --hardhat-ignore-compile` after `npx hardhat compile` (install with `pip install slither-analyzer`)
- Manual review: reentrancy, access control, integer edge cases, unchecked calls, front-running, denial of service, signature replay, input validation

## Other files
- [`card/`](card/): daily LinkedIn card template and design rules
- [`post-style.md`](post-style.md): daily LinkedIn post style
- [`daily-build.md`](daily-build.md): the step-by-step daily build process
