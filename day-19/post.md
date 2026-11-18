Day 19 of building Blockchain 🛠️

Today I built: a mini stablecoin. You lock ETH and mint "Everest Dollars", a coin meant to be worth $1.

How it works:
Think of a gold loan shop. You leave Rs 1,500 of gold for every Rs 1,000 coupon. If gold falls too far, someone can pay back your coupons and take your gold with a small reward. Because there is always more gold than coupons, a coupon stays worth Rs 1,000.

My coin works the same way: at least 150% ETH behind every dollar, or your vault gets liquidated.

What I learned:
The peg depends on the price. A naive version trusted an ETH price that was 2 hours old after a crash. People minted coins backed by only $0.75 each. Mine refuses old prices, and prices stuck at the feed's floor (that is how LUNA broke lending apps in 2022).

19 tests passing, 19 of 19 planted bugs caught.

Tomorrow: a yield vault.

Code: https://github.com/Khadka1996/30-Days-of-Building-Blockchain/tree/main/day-19

#Blockchain #Solidity #DeFi #Stablecoin #BuildInPublic
