Day 6 of building Blockchain 🛠️

Today I built: a crowdfunding contract, like a small Kickstarter on the blockchain. You set a goal and a deadline. Reach the goal and the creator gets the money. Miss it and every backer gets their money back.

How it works:
Think of a school collecting money for a library in a glass box. If the box is full by the deadline, the headteacher takes it once and the box is sealed. If not, each parent takes back the envelope with their own name on it.

What I learned:
The usual first version refunds everyone in one loop. If one backer is a contract that refuses ETH, the whole loop fails and nobody gets refunded. I switched to "pull" refunds: each backer takes their own money back, and can only ever block themselves.

27 tests pass, including 50 random fuzz runs, and a refund costs the same gas with 1 backer or 40.

Tomorrow: Week 1 recap and a deploy kit for the Sepolia test network.

Code: https://github.com/Khadka1996/30-Days-of-Building-Blockchain/tree/main/day-06

#Blockchain #Solidity #Web3 #BuildInPublic #SmartContractSecurity
