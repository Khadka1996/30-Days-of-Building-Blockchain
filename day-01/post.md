Day 1 of building Blockchain 🛠️

Today I built: a to-do list that lives on the blockchain. You can add tasks, mark them done and delete them.

How it works:
Every wallet gets its own list, like a locker that only your key can open. The contract never asks "whose list?". It always uses the wallet that sent the request, so Bob can't touch Alice's tasks even if he tries.

What I learned:
My first idea used a task's position in the list as its ID. But when you delete a task, the last one moves into the gap, so "complete task 2" could finish the wrong task. The fix: every task gets a fixed ID that never changes.

Also: "private" on a blockchain means only you can change it, not only you can see it.

15 tests pass, including 50 random fuzz runs, and the security scanner found 0 issues.

Tomorrow: a piggy bank that only opens after a set date.

Code: https://github.com/Khadka1996/30-Days-of-Building-Blockchain/tree/main/day-01

#Blockchain #Solidity #Web3 #BuildInPublic #SmartContracts
