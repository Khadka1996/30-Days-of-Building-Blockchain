Day 20 of building Blockchain 🛠️

Today I built: a yield vault. You put in dollar tokens, the vault lends them out, and everyone shares the interest.

How it works:
Think of a village savings group. You put money in the box and get a slip for your share. When the loans earn interest, every slip is worth a little more.

What I learned:
A naive vault can be robbed with rounding. The first person puts in 1 wei, then drops 1,000 tokens straight into the box. Your 1,000-token deposit is now worth less than one slip, so you get 0 slips, and he takes everything.

My vault counts its own cash and adds "virtual" slips. The same trick cost the attacker 500 tokens, and the victim lost 0.00025.

Interest also unlocks slowly over 6 hours. Without that, someone jumping in for one block took 96% of the profit.

18 tests passing, 14 of 14 planted bugs caught.

Tomorrow: security and upgrades day.

Code: https://github.com/Khadka1996/30-Days-of-Building-Blockchain/tree/main/day-20

#Blockchain #Solidity #DeFi #ERC4626 #BuildInPublic
