# Daily LinkedIn card — design spec

Template: [`card-template.html`](card-template.html) (option A, dark blue). Render with Playwright at **1080 × 1350** to `day-XX/card/day-XX.png`.

## Keep it simple
- Background: dark navy `#0B1F3A`. Accent: amber `#F59E0B`. Text: white.
- Top: amber badge **"DAY XX / 30"**; right side "30 Days of Building Blockchain".
- Headline: what was built, **max 8 words**, 96 px bold, the key words in amber.
- Panel: **exactly 3 short lines** (max 6 words each), 40 px, numbered amber circles. One line should carry a real number from the run.
- Footer: progress ring (`--p` = day / 30 × 100) showing "X/30", then name and GitHub.
- No code, no small text, no extra decoration. It must be readable as a small thumbnail on a phone.

## Check before posting
Open the PNG and confirm: nothing cut off, no line wrapping inside the panel rows, the headline fits in 3 lines or fewer, and every number matches the real run.
