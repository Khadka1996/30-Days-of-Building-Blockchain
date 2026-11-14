Day 15 of building Blockchain 🛠️

Today I built: a staking pool. You lock tokens and earn rewards every second you stay.

How it works:
Think of a tea shop that gives away 1 cup every minute, shared by everyone sitting inside. Sit for an hour and you get your share of 60 cups. Walk in at the last minute and you get a share of 1 cup, not the whole day's tea.

What I learned:
A naive pool pays each reward deposit at once to whoever is staked at that moment. My test attacker staked just before a deposit and took 9,000 of 10,000 tokens. In my per-second pool, the same trick earned 0.10.

My tests also caught a rounding bug: with the usual 1e18 precision, someone poking the contract 200 times could wipe out 20% of everyone's rewards. Using 1e36 fixed it.

25 tests passing, including 70 random fuzz runs.

Tomorrow: a mini lending pool.

Code: https://github.com/Khadka1996/30-Days-of-Building-Blockchain/tree/main/day-15

#Blockchain #Solidity #DeFi #BuildInPublic #Web3
