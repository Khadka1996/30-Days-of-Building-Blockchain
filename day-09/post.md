Day 9 of building Blockchain 🛠️

Today I built: token vesting. Team tokens stay locked and unlock slowly over 12 months, with nothing for the first 3 months.

How it works:
Think of a salary in a locked box. The box opens after 3 months of work, then a little more is yours each month. If you leave early, you keep what you earned and the company keeps the rest. The owner can never take what was already promised.

What I learned:
Rounding is a quiet thief. If you pay "for the time since the last claim", each small payment rounds down and the loss adds up. So I pay "everything earned so far, minus everything already paid".

My test: 365 daily claims on a tiny grant of 1,000 units. The simple method pays only 730. Mine pays exactly 1,000.

Tomorrow: an airdrop where 1,000 people can claim, with one hash stored on-chain.

Code: https://github.com/Khadka1996/30-Days-of-Building-Blockchain/tree/main/day-09

#Blockchain #Solidity #Web3 #BuildInPublic #Tokenomics
