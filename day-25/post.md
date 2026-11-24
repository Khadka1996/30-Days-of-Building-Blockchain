Day 25 of building Blockchain 🛠️

Today I built: a to-do list you can use with 0 ETH in your wallet. You sign a message for free, and a "relayer" sends the transaction and pays the gas. The task is still saved as yours.

How it works:
It's like a signed cheque and a courier. You sign the cheque, the courier carries it to the bank and pays the bus fare. The bank checks your signature and the cheque number, so the courier can't change it or cash it twice.

The relayer is protected too. It only pays for my app, never sends ETH, and tests every request first, so it never pays for one that would fail.

What I learned:
The common "enough gas?" check runs after the call. My tests showed a sneaky contract can still fake success. Checking before the call fixed it.

I planted 20 security bugs on purpose. The tests caught all 20.

Tomorrow: Layer 2 and cross-chain.

Code: https://github.com/Khadka1996/30-Days-of-Building-Blockchain/tree/main/day-25

#Blockchain #Ethereum #Web3 #BuildInPublic #Solidity
