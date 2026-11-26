#!/usr/bin/env python3
"""Day 27 — plant real security bugs one at a time and check the tests catch each one.

For every bug: change one line, run the tests that should notice, then restore
the file. A bug is "caught" when at least one test fails. All must be caught.
    npm run planted-bugs
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
V, R, M, S, J = "contracts/GuardedVault.sol", "monitor/rules.js", "monitor/monitor.js", "monitor/server.js", "monitor/public/app.js"
VT, MT, ET = "test/GuardedVault.test.js", "test/monitor.test.js", "test/e2e.test.js"

BUGS = [
    # (name, file, old, new, test file)
    ("no daily limit check", V,
     "if (amount > left) revert DailyLimitExceeded(left, amount);", "", VT),
    ("deposits don't refill the limit (F-1 griefing)", V,
     "inflowToday += msg.value;", "", VT),
    ("timelock skipped", V,
     "if (block.timestamp < p.eta) revert TooEarly(p.eta);", "", VT),
    ("a queued change can be silently replaced", V,
     "if (pending[kind].eta != 0) revert AlreadyQueued(kind);", "", VT),
    ("guardian may unpause", V,
     "function unpause() external onlyOwner", "function unpause() external onlyGuardianOrOwner", VT),
    ("anyone may pause", V,
     "function pause() external onlyGuardianOrOwner", "function pause() external", VT),
    ("anyone may cancel a queued change", V,
     "function cancel(Kind kind) external onlyGuardianOrOwner", "function cancel(Kind kind) external", VT),
    ("no re-entrancy guard", V,
     "function withdraw(uint256 amount) external nonReentrant whenNotPaused", "function withdraw(uint256 amount) external whenNotPaused", VT),
    ("balance not reduced on withdraw", V,
     "balanceOf[msg.sender] = bal - amount;", "", VT),
    ("outflow rule only sees the last withdrawal (split drains missed)", R,
     "state.window.push({ t, amount: a.amount });", "state.window = [{ t, amount: a.amount }];", MT),
    ("muted outflow alert never escalates (F-2)", R,
     'const escalated = muted("OUTFLOW_SPIKE") && out >= state.spikeOut * 2n;', "const escalated = false;", MT),
    ("unannounced admin change rated info", R,
     'raise("UNANNOUNCED_CHANGE", "critical"', 'raise("UNANNOUNCED_CHANGE", "info"', MT),
    ("unknown admins not checked", R,
     "if (!isAdmin(by)) raise(", "if (false) raise(", MT),
    ("large-withdrawal threshold 10x too high", R,
     "a.amount * 100n >= BigInt(c.largePct) * before", "a.amount * 10n >= BigInt(c.largePct) * before", MT),
    ("monitor trusts logs from any contract", M,
     "if (!isAddressEqual(l.address, vault.address)) return null;", "", MT),
    ("monitor ignores confirmations", M,
     "const safe = head - BigInt(confirmations) + 1n;", "const safe = head;", MT),
    ("progress not saved (restart re-reads everything)", M,
     "store.save(data); // progress", "// store.save(data); // progress", MT),
    ("acts on old history", M,
     "if (headTime - alert.time > responseMaxAgeSec)", "if (false)", MT),
    ("cancels whatever is queued, not the change it alerted on", M,
     "if (Number(eta) !== alert.eta || value.toString() !== alert.value)", "if (eta === 0n)", MT),
    ("no Host check (DNS rebinding)", S,
     'if (!/^(127\\.0\\.0\\.1|localhost)(:\\d+)?$/.test(String(req.headers.host || ""))) return', "if (false) return", ET),
    ("page renders alert text as HTML", J,
     'el("td", "msg", a.message)', '(() => { const d = el("td", "msg"); d.innerHTML = a.message; return d; })()', ET),
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
        print(f"{i:2}. {'CAUGHT ' if ok else 'MISSED '} {name}", flush=True)
    print(f"\n{caught} of {len(BUGS)} planted bugs caught")
    sys.exit(0 if caught == len(BUGS) else 1)


if __name__ == "__main__":
    main()
