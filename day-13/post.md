Day 13 of building Blockchain 🛠️

Today I built: two NFT auctions. In the English one the price goes up with every bid. In the Dutch one the price falls every second until someone buys.

How it works:
When you are outbid, your money is not sent back straight away. The contract writes it down, like a cloakroom ticket, and you collect it yourself. A bid in the last 10 minutes adds 10 more minutes, so nobody wins by sniping in the final second.

What I learned:
My first idea paid refunds inside the bid. The tests showed the problem: one wallet that refuses money makes every higher bid fail, and it wins with 1 ETH. Writing refunds down fixed it.

46 tests passing, including hostile contracts and 100 random fuzz runs.

Tomorrow: a DAO where members vote with tokens.

Code: https://github.com/Khadka1996/30-Days-of-Building-Blockchain/tree/main/day-13

#Blockchain #Solidity #Web3 #BuildInPublic #SmartContractSecurity
