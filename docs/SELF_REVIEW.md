# Self-Review — PunditPay (hostile-judge simulation)

Applying `.agents/prompts/hackathon-review-prompt.md` to our own build. Written as the skeptical judge who has seen 40 submissions today and the shipping lead who knows what breaks on stage. No cheerleading.

**Inputs:** Rubric = Tether Cup 5 criteria (technical ambition, UX, real-world utility, creativity, real platform use). Team = 1 dev. Field = ~53 registrants, small. Time left to submission = through Jul 14 (build already done; risk is now presentation, not code).

## One-line verdict
**Winnable.** The hard thing is visible, the demo needs no live third party, and it works on a judge's own input. The single risk is not code — it's whether the ≤3-min video lands the "blocked live" beat.

## Step 1 — Hard disqualifiers (the gate)

| Disqualifier | PASS/FAIL | Evidence |
|---|---|---|
| Hard part invisible in demo | **PASS** | The reasoning stream and the live `PolicyViolationError` block ARE the demo, on screen, in `npm run demo`. |
| Needs a live external API on stage | **PASS** | Default demo is 100% local (`--brain=rules --wallet=local`); QVAC/Spark are one-flag upgrades, not stage dependencies. No third party can time out mid-pitch. |
| Only impresses at scale / with real data | **PASS** | One agent, one match, one laptop — the wow is self-contained; no marketplace or network effect needed. |
| Core feature only works on canned input | **PASS (with nuance)** | A judge can curl the jar, change `--pace`, forge/replay an `X-PAYMENT` (gets a specific 402), or edit the rule. The *scripted match* is fixed seed data, disclosed — but the payment machinery is real against arbitrary input. |
| One-sentence problem unstatable from docs | **PASS** | README line 1: the tip that never happened because of accounts/cards/checkout. |

No disqualifier trips. Proceed.

## Step 2 — Scored tests

**A. Shippable (2× buffer) — 10/10.** It's already built and green (268 tests, 100% `src/` line + function + branch coverage, `npm run ci` passes end to end). The only unshipped items are human-gated (video, repo push, on-chain tx), correctly tracked in `PROGRESS.md`. Nothing left to eat a buffer.

**B. Winnable vs the field — 8/10.** Against ~53 teams on a football/QVAC/WDK brief, "agent with its own keys pays over x402, bounded by an in-wallet cap" is the QVAC×WDK Cup-Champion thesis executed with real depth. What could out-shine it: a Pear-native P2P spectacle with a live multi-device moment (more visually dramatic). Our counter is rigor and honesty — but a judge scoring "creativity/UX" might reward theater over correctness. Mitigation: make the video's block beat *visceral*.

**C. Wow-factor & magic moment — 8/10.** The magic beat: **at ~1:55, the agent tries one more tip and its own wallet refuses it in red** (`⛔ PolicyViolationError: would exceed session cap`). That's the "oh" — autonomy that can say no to itself. Second beat: the 90+2' hero tip with the model's own generated reason. Both are timestamped in `DEMO.md`/`VOICEOVER_PROMPT.md`. Eyebrow moves in the first 30s only if the video opens on the payment, not on setup — scripted accordingly.

**D. Non-generic — 9/10.** Not a chatbot, not a dashboard, not a docs example. The closest prior art is Tether's own `qvac-coffee-conversation` (disclosed as the pattern reference) — but swapping "coffee order" for "capped, policy-gated match tipping with a self-audited money path" is a real capability unlock, not a reskin. The two-layer policy (pre-flight + in-wallet) and the authorization-ceiling fix are things a weekend clone wouldn't have.

**E. Documentation polish — 9/10.** README opens problem→solution→proof in the first screen; test count is CI-verified against reality; limitations are stated where they could mislead. Minor: the docs are dense — a judge skimming might miss that `--brain=qvac` is a *real* model and not a mock. The README's live-verified callout and the video's "no cloud AI, ever" line address it.

## The magic moment (build it exactly here)
`0:00` open ON a tip landing (not on setup) → `1:55` the FT over-cap attempt blocked in red, cap meter pinned at 100%. If the video buries either, it caps at 5/10 on winnability regardless of the engineering.

## Action list (ranked by leverage)
**(a) make-it-true** — all closed. The one-time HIGH bug (unbounded settlement vs policy) is fixed and regression-tested (`AUDIT_REPORT.md` §6).
**(b) make-judges-care:**
1. Record the video opening on a payment, not the rule form. (Highest leverage.)
2. Show `--brain=qvac` for ~8s so "real on-device model" is undeniable.
3. Land the red block beat with a beat of silence (see `MUSIC_PROMPT.md`).
4. One sentence, twice: "tipping, never betting" — pre-empt the wrong framing.

## Cut list
- Don't demo `--wallet=spark` live on stage (testnet endpoint-gated; would risk the "needs live API" disqualifier). Show it as a recorded/README artifact only.
- Don't add more models to the demo — three is already more than the pitch needs; extra tokens, no story.
- Resist adding a second match or more creators — dilutes the single engineered run.

## If time is short (top 3)
1. Video that opens on a payment and nails the block beat.
2. Push the public Apache-2.0 repo; paste the URL into README + submission.
3. Register on DoraHacks **by Jul 6**. Ignore: chasing a live Spark testnet tx if the endpoint stays gated — the local-sim path already proves the crypto.
