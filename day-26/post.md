Day 26 of building Blockchain 🛠️

Today I built: two blockchains running side by side, an "L1" like Ethereum and an "L2" like a rollup, and a messenger that carries a to-do task from one to the other.

How it works:
An L2 is like a parcel service. The local van is almost free, but every parcel still needs space on the big ship to the main warehouse (L1). Same gas on both chains, but adding a task cost 72× less on the L2.

To send a task across, 2 of 3 validators must check and sign it. The signature names the exact destination chain, so it can't be replayed on another chain.

What I learned:
One stuck message can freeze a bridge. My first relayer waited on a failing message, blocking everyone behind it. Now failed ones go to a retry list.

I planted 21 security bugs on purpose. The tests caught all 21.

Tomorrow: monitoring and alerts.

Code: https://github.com/Khadka1996/30-Days-of-Building-Blockchain/tree/main/day-26

#Blockchain #Ethereum #Layer2 #Web3 #BuildInPublic
