Day 17 of building Blockchain 🛠️

Today I built: a token swap with a router. Pools trade two tokens each, and the router finds the best path, like HIM → HUSD → NPRT.

How it works:
Think of a money changer where every trade moves the rate. You say: "Give me at least this much, and only in the next 20 minutes." If the rate gets worse, you simply don't trade.

What I learned:
I ran a real sandwich attack in one block. A bot bought just before Ram's swap and sold just after. With no limit, Ram got 29.97% less and the bot kept 14,425 tokens. With a 0.5% limit, Ram's swap just cancelled and the bot lost 999.

Also: two hops beat one. Going through two deep pools gave almost 3× more than one thin pool.

26 tests passing, 16 of 16 planted bugs caught.

Tomorrow: flash loans.

Code: https://github.com/Khadka1996/30-Days-of-Building-Blockchain/tree/main/day-17

#Blockchain #Solidity #DeFi #BuildInPublic #Web3
