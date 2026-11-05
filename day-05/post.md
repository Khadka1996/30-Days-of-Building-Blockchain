Day 5 of building Blockchain 🛠️

Today I built: an escrow contract. When two strangers trade online, the buyer's money waits in the contract until the item arrives.

How it works:
Think of a respected neighbour holding your money while a shop posts you a painting. You say "it arrived", she pays the shop. If you argue, she decides. If you never answer, the shop gets paid after the agreed date.

What I learned:
The real danger is money getting stuck. What if the buyer goes silent? What if the judge disappears? So every situation now has a way out: a deadline for a silent buyer, and a 30-day timeout for a silent judge. And the judge can decide, but never take the money.

29 tests pass, including 60 random fuzz runs, and the tests caught all 6 bugs I planted on purpose.

Tomorrow: Week 1 recap and a deploy kit for the Sepolia test network.

Code: https://github.com/Khadka1996/30-Days-of-Building-Blockchain/tree/main/day-05

#Blockchain #Solidity #Web3 #BuildInPublic #SmartContractSecurity
