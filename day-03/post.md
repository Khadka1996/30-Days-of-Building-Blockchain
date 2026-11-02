Day 3 of building Blockchain 🛠️

Today I built: a voting app. Anyone can create a poll with a closing time. Every address gets one vote, and after the deadline anyone can see the winner.

How it works:
Like a school election with a register at the door. Your name is ticked off the moment you vote, so you can't come back for a second ballot. The doors lock at exactly the deadline, and results are only read out after that.

What I learned:
Small details decide fairness. My first design let the poll creator cancel at any time, so they could throw away a poll their side was losing. Now cancelling only works before the first vote. A tie is also reported as a tie, not quietly given to the first option.

One honest limit: one vote per address is not one vote per person, since anyone can make new addresses.

24 tests pass, including 50 random fuzz runs.

Tomorrow: a multisig wallet that needs 2 of 3 approvals.

Code: https://github.com/Khadka1996/30-Days-of-Building-Blockchain/tree/main/day-03

#Blockchain #Solidity #Web3 #BuildInPublic #SmartContractSecurity
