Day 27 of building Blockchain 🛠️

Today I built: a monitor that watches a smart contract vault and flags unusual activity, with a live dashboard.

How it works:
Think of a shop with CCTV. The camera alone doesn't stop a thief. It helps because the back room has a slow lock and someone can shut the door.

So every admin change waits 24 hours, and the monitor's "guardian" key can only pause the vault or cancel a waiting change. When a stolen admin key tried to lift the withdrawal limit, the monitor cancelled it before it could run.

What I learned:
Thieves split a drain into small withdrawals from many addresses so each looks normal. Adding them up over an hour caught it, and the vault was paused 3 blocks after the last one.

I planted 21 security bugs on purpose. The tests caught all 21.

Tomorrow: the capstone begins.

Code: https://github.com/Khadka1996/30-Days-of-Building-Blockchain/tree/main/day-27

#Blockchain #Solidity #Web3 #Security #BuildInPublic
