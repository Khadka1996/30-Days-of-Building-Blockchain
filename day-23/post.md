Day 23 of building Blockchain 🛠️

Today I built: a live activity feed for my to-do list and piggy bank contracts. Every new task or deposit shows up on a web page within a second.

How it works:
Contracts write "events", like lines in a notebook. A small indexer reads them and saves them. But sometimes the chain tears out its last page or two and rewrites them (a "reorg"). A feed that only adds lines keeps showing a deposit that no longer exists.

So my indexer remembers the fingerprint (hash) of the last block it read. If it changes, it steps back, deletes the old events and reads again.

What I learned:
Block numbers are not identities, hashes are. And my "live" feed was 3–4 seconds behind, because viem caches the block number. One raw call fixed it.

I fuzzed it with 160 random reorgs and restarts: 0 mismatches with the chain.

Tomorrow: Sign in with Ethereum.

Code: https://github.com/Khadka1996/30-Days-of-Building-Blockchain/tree/main/day-23

#Blockchain #Ethereum #Web3 #BuildInPublic #Solidity
