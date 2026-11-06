Day 7 of building Blockchain 🛠️

Today I built: a deploy kit that takes all six Week 1 contracts from my laptop to Sepolia, the free Ethereum test network, and publishes their code on Etherscan.

How it works:
Think of moving house. Before the truck comes, you check the address, keep the keys in your pocket (not taped to the door), and make sure you can pay for the whole move. The kit does the same: right network, private key never in git, enough ETH for all six contracts. Only then does it send anything.

What I learned:
Most losses happen around the code, not in it. A key pushed to GitHub or a script pointed at mainnet can lose money even if every contract is perfect. And if the deploy crashes half-way, running it again skips what is already live, so nothing is paid twice.

21 tests pass, and a wallet with too little ETH sent 0 transactions.

Tomorrow: my own ERC-20 token and a once-a-day faucet.

Code: https://github.com/Khadka1996/30-Days-of-Building-Blockchain/tree/main/day-07

#Blockchain #Solidity #Web3 #BuildInPublic #Ethereum
