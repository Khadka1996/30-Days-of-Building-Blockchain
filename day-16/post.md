Day 16 of building Blockchain 🛠️

Today I built: a mini lending pool. Lenders put in dollar tokens and earn interest. Borrowers lock other tokens as collateral and borrow up to 75% of their value.

How it works:
Think of a pawn shop. You leave a necklace worth Rs 10,000 and borrow Rs 7,000. If gold falls too far, the shop sells the necklace before it is worth less than the loan. Here anyone can do that sale and earn a 5% bonus.

What I learned:
The price source is the real security. In a naive pool, my test attacker pushed the price from $1.00 to $15.96 with one trade, borrowed all 50,000 tokens and kept 42,690. My pool reads a price feed that trades cannot move, so the same attacker could borrow only 3,150.

After a crash, debt nobody can repay is written off openly, so every lender loses the same.

21 tests passing, 14 of 14 planted bugs caught.

Tomorrow: a swap with a router.

Code: https://github.com/Khadka1996/30-Days-of-Building-Blockchain/tree/main/day-16

#Blockchain #Solidity #DeFi #BuildInPublic #Web3
