# Test the tests: plant 12 real security bugs one at a time and check that
# `npm test` catches every one. Each file is restored after its run.
# Run: npm run planted-bugs   (about 3 minutes)
import subprocess, shutil, sys, os
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
M0 = [
 ("NoDomainCheck","auth/siwe-check.js",'if (m.domain !== expect.domain)','if (false)'),
 ("NoUriCheck","auth/siwe-check.js",'if (uriOrigin !== expect.origin)','if (false)'),
 ("NoChainCheck","auth/siwe-check.js",'if (m.chainId !== expect.chainId)','if (false)'),
 ("NoNonceCheck","auth/siwe-check.js",'if (!expect.nonce || m.nonce !== expect.nonce)','if (false)'),
 ("LenientParser","auth/siwe-check.js",'if (rebuilt !== text)','if (false)'),
 ("NoExpiryCheck","auth/siwe-check.js",'if (m.expirationTime.getTime() <= now)','if (false)'),
 ("NonceNeverBurned","auth/server.js",'if (pre) pending.delete(pre);','// burned later'),
 ("NoOriginCheck","auth/server.js",'return req.headers.origin === cfg.origin;','return true;'),
 ("SessionFixation","auth/server.js",'const sid = randomId();','const sid = pre || randomId();'),
 ("LogoutKeepsSession","auth/server.js",'if (s) sessions.delete(s.sid);','// cookie cleared only'),
 ("EcrecoverOnly","auth/server.js",'valid = await cfg.client.verifyMessage({','valid = await require("viem").verifyMessage({'),
 ("NoSessionCap","auth/server.js",'for (const [oldSid] of mine','for (const [oldSid] of []'),
]
M = [m for m in M0 if m[0] in sys.argv[1:]] or M0
for name, f, old, new in M:
    src = open(f).read(); assert src.count(old)==1, name
    shutil.copy(f, f+".bak"); open(f,"w").write(src.replace(old,new))
    try:
        r = subprocess.run("npx hardhat test test/auth.test.js test/fuzz.test.js test/e2e.test.js", shell=True, capture_output=True, text=True, timeout=400)
        out = r.stdout
        fails = [l.strip() for l in out.splitlines() if l.strip().endswith("failing")]
        print(f"{name:20s} {'CAUGHT' if r.returncode else 'MISSED'} {fails}", flush=True)
    finally:
        shutil.move(f+".bak", f)
