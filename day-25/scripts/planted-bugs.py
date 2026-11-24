# Test the tests: plant real security bugs one at a time and check that
# `npm test` catches every one. Each file is restored after its run.
# Run: npm run planted-bugs   (about 8 minutes)   or: python3 scripts/planted-bugs.py NoGasCheck
import subprocess, shutil, sys, os
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
F, R, P = "contracts/Forwarder.sol", "relayer/server.js", "public/app.js"
M0 = [
 # --- on-chain (Forwarder) ---
 ("NoNonceCheck",      F, 'if (req.nonce != expected) revert BadNonce(expected, req.nonce);', ''),
 ("NonceNotSpent",     F, 'nonces[req.from] = expected + 1;', 'nonces[req.from] = expected;'),
 ("NoDeadlineCheck",   F, 'if (req.deadline < block.timestamp) revert Expired(req.deadline);', ''),
 ("NoSignerCheck",     F, 'if (_signerOf(req, signature) != req.from) revert BadSignature();', ''),
 ("DataNotSigned",     F, 'keccak256(req.data)', 'keccak256("")'),
 ("NoTrustCheck",      F, 'if (!_trusts(req.to)) revert UntrustfulTarget(req.to);', ''),
 ("TrustAnyAnswer",    F, 'return ok && returned == 32 && answer == 1;', 'return ok && answer != 0;'),
 ("NoGasCheck",        F, 'if (gasleft() < (gasLimit * 64) / 63 + CALL_OVERHEAD) revert NotEnoughGas(gasLimit);', ''),
 ("NoValueCheck",      F, 'if (msg.value != req.value) revert ValueMismatch(req.value, msg.value);', ''),
 ("UncappedRevertData",F, '_returnDataUpTo(MAX_REVERT_BYTES)', '_returnDataUpTo(type(uint256).max)'),
 # --- off-chain (relayer) ---
 ("NoPreflight",       R, 'const estimate = await preflight(req, signature);', 'const estimate = 500_000n;'),
 ("NoTargetPolicy",    R, 'if (req.to !== todo.address)', 'if (false)'),
 ("NoSelectorPolicy",  R, 'if (size(req.data) < 4 || !allowed.has(slice(req.data, 0, 4)))', 'if (false)'),
 ("NoValuePolicy",     R, 'if (req.value !== 0n)', 'if (false)'),
 ("NoGasCap",          R, 'if (req.gas > limits.maxGas)', 'if (false)'),
 ("NoDeadlineHorizon", R, 'if (req.deadline > t + limits.maxDeadlineAhead)', 'if (false)'),
 ("NoRateLimit",       R, 'if (mine.length >= limits.ratePerMinute)', 'if (false)'),
 ("QuotaBeforeSigCheck", R, '    takeQuota(signer, t);\n', ''),  # paired edit below
 ("NoQueueCap",        R, 'if (queued >= limits.maxQueue)', 'if (false)'),
 # --- page ---
 ("XssInnerHtml",      P, 'span.textContent = t.text;', 'span.innerHTML = t.text;'),
]
EXTRA = {"QuotaBeforeSigCheck": (R, '    policy(req, t);\n', '    policy(req, t);\n    takeQuota(req.from, t);\n')}
M = [m for m in M0 if m[0] in sys.argv[1:]] or M0
caught = 0
for name, f, old, new in M:
    edits = [(f, old, new)] + ([EXTRA[name]] if name in EXTRA else [])
    for ef, eo, en in edits:
        src = open(ef).read(); assert src.count(eo) == 1, (name, eo)
        if not os.path.exists(ef + ".bak"): shutil.copy(ef, ef + ".bak")
        open(ef, "w").write(src.replace(eo, en))
    try:
        r = subprocess.run("npx hardhat test", shell=True, capture_output=True, text=True, timeout=600)
        fails = [l.strip() for l in r.stdout.splitlines() if l.strip().endswith("failing")]
        ok = r.returncode != 0
        caught += ok
        print(f"{name:20s} {'CAUGHT' if ok else 'MISSED'} {fails}", flush=True)
    finally:
        for ef in {e[0] for e in edits}: shutil.move(ef + ".bak", ef)
print(f"{caught} of {len(M)} planted bugs caught")
