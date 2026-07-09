# PunditPay — Pitch Deck (12 slides + speaker notes)

Design: canvas `#0B0E11`, panels `#12161C`, reasoning cyan `#38BDF8`, money green `#26A17B`, cap amber `#FFB020`, blocked red `#FF4D4F`. Inter + monospace. One idea per slide.

---

### Slide 1 — Title
**PunditPay** — *the on-device agent that tips with its own keys.*
Visual: the console's hero beat — a cyan reasoning line resolving into a green `✓ TIP SENT · 0.25 USD₮ · tx …`.
> **Say:** "This is an AI with its own wallet paying a human being for a great football call — and nothing left the device except the payment."

### Slide 2 — The problem
*The tip that never happened.* You wanted to tip the streamer who called the stoppage-time comeback. Account. Card. Checkout. Data. The moment passed.
> **Say:** "Football runs on live micro-moments, and there is no frictionless way to put a few cents behind one. Every path kills the impulse — so creators earn applause instead of money."

### Slide 3 — The solution
An agent that watches with you, **reasons on your device**, and pays over **plain HTTP** when your own rule says the moment earned it. One round-trip. No account on either side.
> **Say:** "You set two things once: a confidence rule and a hard cap. The agent does the rest — and can never exceed either."

### Slide 4 — Live demo
`npm run demo` → the 23' tip · the half-time pay-per-pick · the 90+2' hero tip (96% confidence) · **the FT attempt blocked in red by `PolicyViolationError`** · books balance at exactly 1.00 USD₮.
> **Say:** "Everything you just saw is one command. And my favorite beat is the refusal — autonomy is only a feature if it's bounded."

### Slide 5 — How it works
Diagram: moment → QVAC `completion()` tool-calling → schema validation → **Transaction Policy (default-deny)** → x402 (402 → sign → receipt) → plain-language ledger.
> **Say:** "The model proposes; the policy disposes. The model is inside our threat model — a jailbroken brain still can't outspend the cap."

### Slide 6 — Why only QVAC + WDK
QVAC: on-device GGUF brain with tool-calling. WDK: self-custodial keys + in-wallet Transaction Policies + zero-fee Spark settlement. x402: the payment is the credential.
> **Say:** "Remove them and you need six systems — cloud LLM, processor, accounts, checkout, custodian, limits engine — plus a data-sharing agreement."

### Slide 7 — The market moment
Agent payments are the loudest promise in tech right now — and almost every 'agent wallet' is a custodial API with a spending limit in someone else's database.
> **Say:** "We think the credible version is exactly this shape: keys on-device, limits in the wallet, payments over open HTTP. Football is the perfect first market: billions of fans, cent-sized gratitude, zero patience for checkouts."

### Slide 8 — Business model
Creators run tip jars (open protocol, no platform take). Revenue: hosted jar infrastructure, premium pick marketplaces, skill licensing to other agent platforms.
> **Say:** "The protocol stays open — that's the point. We monetize convenience, not custody."

### Slide 9 — Traction & proof
**268 tests** (all green, **100% line + function + branch coverage on `src/`**, CI-gated) · x402 round-trip **p50 ≈0.8 ms** · offline-verified reasoning · framing linter (betting vocab fails CI) · full engineering harness (6-stage CI, CodeQL, TruffleHog).
> **Say:** "Every number on this slide is a script in the repo you can re-run. The README's test count is checked by CI against reality."

### Slide 10 — Roadmap
30 days: USD₮-native Spark settlement + voice ("tip that call") via QVAC Whisper. 60: creator jar directory + reputation. 90: the skill on every major agent platform (MCP toolkit drop-in ready).
> **Say:** "The skill file already speaks MCP — when Tether's toolkit package ships, PunditPay is a drop-in."

### Slide 11 — Team
Edy Cu — solo build, spec to shipping in one sprint on the Tether stack. Serial hackathon shipper (ZK, agents, payments).
> **Say:** "One person, three SDKs, zero other dependencies — that's a statement about the stack as much as about me."

### Slide 12 — Close
**An AI with its own wallet just paid a human — and its wallet told it no when it should.**
> **Say:** "Rewarding the people who make football fun should be as fast as the moment itself. Thank you — and thank you to the Tether team for SDKs that made this real."
