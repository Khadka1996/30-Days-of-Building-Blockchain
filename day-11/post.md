Day 11 of building Blockchain 🛠️

Today I built: an NFT collection called Himal Peaks, with an early sale, a public sale and a hard limit of 100 tokens.

How it works:
Think of a concert. Fan club members get early tickets at a lower price, then general sale opens. Each person has a limit at the door, a few seats are kept for the crew, and the hall can never hold more than 100.

What I learned:
When an NFT is minted, the contract calls the buyer's wallet. A sneaky bot contract can use that moment to buy again before its count is saved. So I save the count first and lock the mint function. A test bot tried it and was blocked.

31 tests passed, including 300 real early-sale mints and 100 random sale runs.

Tomorrow: an NFT marketplace with creator royalties.

Code: https://github.com/Khadka1996/30-Days-of-Building-Blockchain/tree/main/day-11

#Blockchain #Solidity #Web3 #BuildInPublic #NFT
