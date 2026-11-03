Day 4 of building Blockchain 🛠️

Today I built: a multisig wallet. It is a shared wallet with 3 owners, and every payment needs 2 of them to approve it.

How it works:
Like a family bank account where every cheque needs two signatures. One owner proposes a payment, a second owner approves it, and only then can it be sent. Once paid, it is stamped "PAID", so the same payment can never be cashed twice.

What I learned:
Counting approvals is not enough. In my first design, if an owner approved a payment and was then removed, their old approval still counted. One remaining owner could finish the job alone. Now every owner change makes old proposals stale, so they must be approved again.

25 tests pass, including 50 random fuzz runs.

Tomorrow: an escrow, where money waits safely until the buyer gets the item.

Code: https://github.com/Khadka1996/30-Days-of-Building-Blockchain/tree/main/day-04

#Blockchain #Solidity #Web3 #BuildInPublic #SmartContractSecurity
