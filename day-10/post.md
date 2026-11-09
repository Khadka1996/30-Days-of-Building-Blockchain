Day 10 of building Blockchain 🛠️

Today I built: an airdrop where 1,000 people can claim tokens, but the contract stores just one hash.

How it works:
Think of a sealed list at the bank. The bank keeps only a fingerprint of the list. You bring your line plus a few matching hashes, and the fingerprint proves you are on it. Those few hashes are called a Merkle proof, about 10 for 1,000 people.

What I learned:
A copied proof must be useless. So the contract builds your entry from the wallet that is calling. Someone who copies your proof gets rejected.

The tests made 1,000 real claims, and also tried claiming twice and faking proofs. Setup used 18.5 times less gas than storing every address.

Tomorrow: an NFT collection with an allowlist and a max supply.

Code: https://github.com/Khadka1996/30-Days-of-Building-Blockchain/tree/main/day-10

#Blockchain #Solidity #Web3 #BuildInPublic #MerkleTree
