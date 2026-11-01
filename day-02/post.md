Day 2 of building Blockchain 🛠️

Today I built: a piggy bank with a time lock. You put ETH in, pick an unlock date, and nobody can take it out before then. Not even you.

How it works:
Like a clay piggy bank with a timer. You can drop more coins in any time and push the date later, but never earlier. After the date, only your wallet can open it.

What I learned:
Order matters when sending money. If the contract sends the ETH first and updates your balance after, a sneaky contract can call "withdraw" again in the middle and get paid twice. It's like a cashier paying you before crossing your name off the list.

The fix: check the rules, set the balance to zero, then send the ETH. My attack test tried exactly this trick and got nothing extra.

22 tests pass, including 50 random fuzz runs.

Tomorrow: a voting app with one vote per person.

Code: https://github.com/Khadka1996/30-Days-of-Building-Blockchain/tree/main/day-02

#Blockchain #Solidity #Web3 #BuildInPublic #SmartContractSecurity
