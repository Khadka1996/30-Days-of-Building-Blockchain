Day 18 of building Blockchain 🛠️

Today I built: flash loans. A lender that gives you millions with no guarantee, as long as you pay it back (plus 0.09%) in the same transaction. If you don't, everything is undone.

How it works:
Think of a bank that lends you Rs 1 crore, but you must return it before you leave the counter. You can't run away with it, so the bank takes no risk.

My bot used it to buy a token where it was cheap and sell it where it was dear. It earned 2,817 HUSD starting with 0.

What I learned:
The dark side. A bonus contract paid people for how many tokens they held "right now". An attacker borrowed 100,000 tokens for one transaction, looked rich, and took the whole 10,000 HUSD pot. The fix: check balances at a past block. A flash loan never shows up there.

29 tests passing, 17 of 17 planted bugs caught.

Tomorrow: a mini stablecoin.

Code: https://github.com/Khadka1996/30-Days-of-Building-Blockchain/tree/main/day-18

#Blockchain #Solidity #DeFi #BuildInPublic #Web3
