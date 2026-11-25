#!/usr/bin/env python3
"""Day 26 — plant real security bugs one at a time and check the tests catch each one.

For every bug: change one line, run the tests that should notice, then restore
the file. A bug is "caught" when at least one test fails. All must be caught.
    npm run planted-bugs
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
M, T, R, A, J = "contracts/Messenger.sol", "contracts/CrossChainTodo.sol", "relayer/relayer.js", "app/server.js", "app/public/app.js"
CT, RT, ET = "test/Messenger.test.js", "test/relayer.test.js", "test/e2e.test.js"

BUGS = [
    # (name, file, old, new, test file)
    ("no destination-chain check (cross-chain replay)", M,
     "if (m.dstChainId != block.chainid) revert", "if (false) revert", CT),
    ("no destination-messenger check (twin replay)", M,
     "if (m.dstMessenger != address(this)) revert", "if (false) revert", CT),
    ("no trusted-source check", M,
     "if (trusted == address(0) || m.srcMessenger != trusted) revert", "if (false) revert", CT),
    ("never marks messages as processed (replay)", M,
     "processed[id] = true;", "", CT),
    ("no already-processed check (replay)", M,
     "if (processed[id]) revert AlreadyProcessed(id);", "", CT),
    ("same validator may sign twice", M,
     "if (signer <= last) revert", "if (signer < last) revert", CT),
    ("non-validators may sign", M,
     "if (!isValidator[signer]) revert NotAValidator(signer);", "", CT),
    ("one signature is enough", M,
     "for (uint256 i = 0; i < threshold; i++)", "for (uint256 i = 0; i < 1; i++)", CT),
    ("id does not include the destination chain", M,
     "MESSAGE_TYPEHASH, m.srcChainId, m.srcMessenger, m.dstChainId, m.dstMessenger,",
     "MESSAGE_TYPEHASH, m.srcChainId, m.srcMessenger, uint256(0), m.dstMessenger,", CT),
    ("1-of-N validator sets allowed", M,
     "threshold_ * 2 <= n ||", "", CT),
    ("anyone may pause", M,
     "function pause() external onlyOwner", "function pause() external", CT),
    ("anyone may call onMessage", T,
     "if (msg.sender != messenger) revert NotMessenger();", "", CT),
    ("app accepts any source chain", T,
     "if (srcChainId != trustedSource) revert UntrustedSource(srcChainId);", "", CT),
    ("tasks not separated per chain", T,
     "return keccak256(abi.encode(chainId, owner));", "return keccak256(abi.encode(owner));", CT),
    ("validator signs events from any contract", R,
     'if (!isAddressEqual(log.address, srcMessenger)) throw new Error("log not from the source Messenger");', "", RT),
    ("validator ignores confirmations", R,
     'if (head - receipt.blockNumber + 1n < BigInt(confirmations)) throw new Error("not enough confirmations");', "", RT),
    ("relayer does not wait for confirmations", R,
     "const safe = head - BigInt(confirmations) + 1n;", "const safe = head;", RT),
    ("failed messages are dropped, not retried", R,
     "pending.set(id, { txHash, logIndex });", "", RT),
    ("relayer ignores its target allow-list", R,
     "if (allowed && !allowed.some", "if (false && !allowed.some", RT),
    ("no Host check (DNS rebinding)", A,
     'if (!/^(127\\.0\\.0\\.1|localhost)(:\\d+)?$/.test(String(req.headers.host || ""))) throw', "if (false) throw", ET),
    ("page renders task text as HTML", J,
     'el("span", "t", m.text)', '(() => { const s = el("span", "t"); s.innerHTML = m.text; return s; })()', ET),
]


def run(test):
    r = subprocess.run(["npx", "hardhat", "test", test], cwd=ROOT, capture_output=True, text=True, timeout=600)
    return r.returncode != 0


def main():
    caught = 0
    for i, (name, f, old, new, test) in enumerate(BUGS, 1):
        p = ROOT / f
        src = p.read_text()
        if src.count(old) != 1:
            print(f"{i:2}. {name}: PATTERN NOT FOUND in {f}")
            sys.exit(2)
        p.write_text(src.replace(old, new))
        try:
            ok = run(test)
        finally:
            p.write_text(src)
        caught += ok
        print(f"{i:2}. {'caught ' if ok else 'MISSED '} {name}  ({f})", flush=True)
    print(f"\n{caught} of {len(BUGS)} planted bugs caught")
    subprocess.run(["npx", "hardhat", "compile", "--quiet"], cwd=ROOT, capture_output=True)
    sys.exit(0 if caught == len(BUGS) else 1)


if __name__ == "__main__":
    main()
