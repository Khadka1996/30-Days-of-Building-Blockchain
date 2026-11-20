Day 21 of building Blockchain 🛠️

Today I built: an attack day for Week 3, plus a safe upgrade.

How it works:
I wrote a robot that throws random actions at my staking, lending, swap and vault contracts: deposits, price crashes, liquidations, time jumps. After every action it checks rules that must always hold, like a bank inspector counting the cash against the ledger after each customer.

Then I put my staking contract behind a proxy and upgraded it from V1 to V2 while people were staked. Same address, every balance kept.

What I learned:
In an upgradeable contract, the order of variables matters. Storage is like numbered lockers. My broken V2 added one variable at the top, so every name opened the wrong locker: the staking token became the reward token and 4,000 tokens got stuck.

In 800 random runs (11,352 actions), no rule broke. To test my tests, I planted 15 bugs. The first version missed 3. Now 15 of 15 are caught.

Tomorrow: Week 4 starts with a Next.js dApp.

Code: https://github.com/Khadka1996/30-Days-of-Building-Blockchain/tree/main/day-21

#Blockchain #Solidity #SmartContractSecurity #Web3 #BuildInPublic
