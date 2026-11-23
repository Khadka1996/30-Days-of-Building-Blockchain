Day 24 of building Blockchain 🛠️

Today I built: a login page with no password. You click "Sign in with Ethereum", your wallet signs a short message, and you see your tasks from my Day 1 to-do contract. Free, no transaction.

How it works:
A signature only proves "this key signed this text". So the text must say everything: which website, which chain, a one-time code, and when it expires. Like a cheque: worthless unless it names who it's for and has a number that can only be cashed once.

The server checks all of it. A fake website can trick you into signing, but the message then names the fake site, so my server refuses it. A copied signature fails too, because its one-time code is already used.

What I learned:
viem's message reader quietly ignores an extra hidden "Nonce:" line. Now the server demands the exact text, byte for byte.

I planted 12 security bugs on purpose. The tests caught all 12.

Tomorrow: gasless transactions.

Code: https://github.com/Khadka1996/30-Days-of-Building-Blockchain/tree/main/day-24

#Blockchain #Ethereum #Web3 #BuildInPublic #CyberSecurity
