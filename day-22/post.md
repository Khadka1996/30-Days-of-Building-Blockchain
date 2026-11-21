Day 22 of building Blockchain 🛠️

Today I built: a real web app for my Day 1 to-do list and Day 2 piggy bank, with "Connect wallet".

How it works:
The page never sees your private key. It asks your wallet to sign, like a shop asking you to tap your card: you see what you are paying, and you can say no. Before every click it checks you are on the right network, and does a dry run so a "still locked" error shows up before the wallet even opens.

What I learned:
"Sent" is not "done". When I pressed Cancel in the wallet, my first version still showed "Done ✓", because the receipt it got back belonged to the cancel transaction. Now it checks the transaction really ran.

17 of 17 browser tests pass, covering wrong networks, rejections, cancels and dropped transactions.

Tomorrow: a live activity feed from contract events.

Code: https://github.com/Khadka1996/30-Days-of-Building-Blockchain/tree/main/day-22

#Blockchain #Web3 #NextJS #BuildInPublic #Ethereum
