Day 14 of building Blockchain 🛠️

Today I built: a DAO. Members hold tokens, 1 token = 1 vote. Anyone with enough tokens can propose "pay 5 ETH to a school library", everyone votes for a week, and if it passes the money moves 2 days later.

How it works:
Think of a village committee. The voter list is written down before voting starts, so someone who turns up with borrowed land papers on voting day does not count. The 2-day wait gives anyone who disagrees time to act.

What I learned:
I also built a naive DAO that counts votes from your balance right now. An attacker with 0 tokens borrowed 60% of the supply for one transaction (a flash loan), voted, and took the whole 10 ETH treasury. In my DAO the same loan counts as 0 votes.

34 tests passing, including 100 random fuzz runs.

Tomorrow: staking with rewards every second.

Code: https://github.com/Khadka1996/30-Days-of-Building-Blockchain/tree/main/day-14

#Blockchain #Solidity #Web3 #BuildInPublic #DAO
