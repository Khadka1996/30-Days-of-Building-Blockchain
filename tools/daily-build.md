# Daily build instructions (used by the scheduled runs)

Day 1 = 31 October 2026. **Day = (today in Asia/Kathmandu − 30 October 2026) in days.** `XX` = zero-padded day (01…30), `X` = unpadded.

The day's project, skills and security focus are in [`ROADMAP.md`](../ROADMAP.md). Build on earlier days so the series reads as one progression.

## Rules
- Commits are authored by **Manish Khadka <mnzkhadka1996@gmail.com>** only. **No Co-Authored-By, Claude-Session or any AI trailer**, ever.
- Never commit secrets, private keys or `.env` files. Use `.env.example` with placeholders.
- Keep each project small, focused and production-quality: clean, commented code a learner can read in 20 minutes.
- Every number in the README, card and post must come from the real run.

## Environment notes (verified)
- Solidity compiler downloads, Foundry and public RPCs / test networks are **blocked**. Use the offline Hardhat setup in [`tools/README.md`](README.md) (solcjs via `tools/hardhat.config.template.js`); never use hardhat-toolbox.
- Everything runs on the **local Hardhat network**. For multi-chain days, run two local Hardhat nodes on different ports and chain IDs.
- npm works. `pip install --break-system-packages slither-analyzer` works. Python Playwright + Chromium and the Inter font are installed.
- Fuzz and invariant tests: JavaScript with **fast-check**.

## Steps

### 1. Build `day-XX/`
- **Solidity days:** `contracts/`, `test/`, `package.json` with npm scripts (`test`, `lint`, `compile`), `hardhat.config.js` from the template.
- **Week 4 (Days 22–27):** a small Next.js (or plain HTML/JS if simpler) front end in `day-XX/app/` using **viem / wagmi** against a local Hardhat node, with Playwright browser tests where useful. Reuse earlier days' contracts.
- **Day 7:** a deploy kit: `scripts/deploy.js` for Sepolia, `.env.example`, Etherscan verification commands and `DEPLOY.md` with step-by-step instructions for Manish to run from his own laptop with a test-only wallet. Do **not** attempt a network deployment.
- **Days 28–30 (capstone):** the app lives in `capstone/` at the repo root. Day 28: choose a real, specific Nepal problem, write the design (who uses it, what goes on-chain and why) and build the contracts with full tests. Day 29: the web app, end-to-end tests and a deploy kit. Day 30: a professional self-audit report (`capstone/AUDIT.md`), a demo walkthrough, and a wrap-up section in the root README (what was built, links to every day, 5 lessons, next steps). Each `day-28/29/30/` folder holds that day's README, QA.md and card.

### 2. QA and security loop (mandatory)
Run tests, `npm audit --omit=dev`, solhint, `npx hardhat compile` then `slither . --hardhat-ignore-compile`. Then review like an attacker using the day's security focus from ROADMAP.md and the checklist in `tools/README.md`. For each real issue: write a failing test, fix, re-run everything. Repeat until green with no high or medium findings (max 5 rounds; leftovers logged as "Known issue" with reasoning). Write `day-XX/QA.md`: findings table (ID, severity, found by, description, fix, proving test) and the final green output.

### 3. `day-XX/README.md` (plain words)
Sections: **What I built** (2–3 sentences anyone can follow) · **How it works** (simple steps, an ASCII or Mermaid diagram) · **Run it yourself** (exact commands) · **Results from my run** (real output) · **What I learned** (3 bullets) · **Security notes** (link to QA.md) · Week 3 only: **What a real protocol adds** · **References** (3–5 authoritative links) · **Next:** tomorrow's project.

### 4. Card `day-XX/card/day-XX.png`
Copy `tools/card/card-template.html` to `day-XX/card/card.html` and follow `tools/card/README.md` exactly: badge `DAY XX / 30`, headline max 8 words with the key words in `<em>`, exactly 3 panel lines (max 6 words each, one with a real number), ring `--p` = X/30×100 and label `X/30`. Render with Python Playwright at 1080×1350, open the PNG, and fix anything cut off, wrapped or overlapping before continuing.

### 5. Post text `day-XX/post.md`
Follow `tools/post-style.md` exactly. First line exactly `Day X of building Blockchain 🛠️`. 100–180 words, simple words, one real number, link `https://github.com/Khadka1996/30-Days-of-Building-Blockchain/tree/main/day-XX`, 4–5 hashtags. Day 30: a wrap-up of all 30 days linking the whole repo. The file contains only the post text.

### 6. Update and push
In the root README, change the day's status from ⏳ to ✅ and link the project name to `day-XX`. Commit `Day XX: <project> — <what was built>`, `git fetch` + rebase on `origin/main`, push, and verify that `https://raw.githubusercontent.com/Khadka1996/30-Days-of-Building-Blockchain/main/day-XX/card/day-XX.png` and `.../day-XX/post.md` return HTTP 200 (retry every 15 s, up to 3 min).
