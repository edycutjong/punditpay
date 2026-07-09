# PunditPay — DoraHacks BUIDL Submission

> Copy-paste bundle: each section maps 1:1 to the BUIDL form. Fields only a human can supply are marked ⬜ FILL. Everything else is true of the build in this repo **today** — re-verify with `npm run check:readiness` before pasting.

## 1. Profile

- **BUIDL Name**: PunditPay
- **BUIDL Logo**: `docs/assets/icon-512.png` (512×512 PNG, symbol-only)
- **Category**: Crypto / Web3
- **Vision** (199/256 chars):
  `Agent payments people can actually trust: the AI reasons on your device, holds its own keys, pays over open HTTP — and its own wallet enforces your spend cap. Reward the humans who make football fun.`
- **Elevator Pitch** (138/150 chars):
  `A fully-local AI agent that tips football commentators in USD₮ over x402 — on-device brain, self-custodial keys, hard in-wallet spend cap.`
- **Innovation Domains**: Crypto-AI · Wallet · Creator Economy · Infra / API
- **L1s**: Bitcoin (Spark is a Bitcoin L2 — settlement layer for the demo)

## 2. Project Story

### Inspiration
I wanted to tip the streamer who called a stoppage-time comeback — and gave up somewhere between "create an account" and "enter card details." The moment passed; the tip never happened. Meanwhile every "AI agent payments" demo I saw still assumed a human clicking checkout and a custodian holding the keys. The Tether stack — QVAC for an on-device brain, WDK for self-custodial keys with in-wallet policies, x402 for pay-over-HTTP — is the first combination where the honest version of that promise is buildable in a sprint.

### What it does
1. **Reasons about the match on-device.** A local GGUF model (`LLAMA_TOOL_CALLING_1B_INST_Q4_K`, via `@qvac/sdk` `completion()` with tool-calling) watches a match feed with your rule injected: *"tip only above 70% confidence."* A deterministic confidence engine (`+30 called-it, +1/min lead time, +16·hit-rate…`) grounds every judgment; the same math runs in `--brain=rules` mode for reproducible CI.
2. **Decides to pay — the model, not a button.** When a moment clears the rule, the model emits a structured `pay_tip(amount, to, reason, confidence)` tool call. Malformed calls are schema-rejected before they can touch money.
3. **Enforces bounded autonomy, twice.** A default-deny Transaction-Policy engine (session cap 1.00 USD₮, per-tip max, tip count, optional allowlist) judges every operation BEFORE signing; in spark mode the same limits are also registered inside the WDK wallet via `wdk.registerPolicy()` — over-cap attempts throw `PolicyViolationError` from the wallet itself.
4. **Pays over plain HTTP (x402).** GET → 402 + offer → wallet settles + signs canonical bytes → paid retry with `X-PAYMENT` → resource + receipt. Single-use nonces, tamper-evident signatures, address↔key binding: replay, tamper and impostor attacks are all rejected (and tested).
5. **Buys real content too.** At half-time the agent purchases an actual tactical read from a creator for 0.25 USD₮ via the same x402 flow — pay-per-pick, no subscription.
6. **Explains itself.** Every decision is one plain-language ledger line with a tx hash; a live local console (reasoning terminal, x402 handshake card, amber cap meter, action log) streams the session over SSE with zero external requests.

### How we built it
| Layer | Technology | Why |
|---|---|---|
| Brain | `@qvac/sdk@0.14.1` — `loadModel`/`completion` + tools | on-device tool-calling; the whole brain is a local file |
| Keys & policy | `@tetherto/wdk@1.0.0-beta.12` | BIP-39 self-custody + the best guardrail primitive we've used (`registerPolicy`, `PolicyViolationError`, `simulate`) |
| Settlement | `@tetherto/wdk-wallet-spark@1.0.0-beta.22` | zero-fee transfers make $0.05 tips economical; read-only server-side verification |
| Payments | x402 (native impl, `src/core/x402.js`) | 402 offer → signed payment → resource; the payment is the credential |
| Everything else | node:core only (crypto, http, test) | 3 runtime deps total — all Tether |

**Quality & Security Engineering:** 268 tests / 62 suites (node:test, <1 s, all green, **100% line + 100% function + 100% branch coverage on `src/`**, enforced by a CI coverage gate; the live QVAC model + Spark testnet calls are coverage-disabled with honest one-line reasons, and the `bin/` CLI bootstrap is excluded from the gate but covered by the real-subprocess CLI suite) covering every invariant incl. an adversarial "hostile brain" suite and a self-audit regression set; 6-stage CI (quality → security → build → e2e → perf → gate); CodeQL SAST; Dependabot; TruffleHog secret scan; a custom lint that FAILS the build on betting vocabulary (framing guard) or cloud-AI hosts (zero-cloud guard); reproducible benchmarks (`npm run bench`: x402 round-trip p50 ≈0.8 ms); offline verification that kills fetch+sockets and proves all 9 decisions still happen.

### Challenges we ran into
1. **WDK's default-deny nearly ate our payment signatures.** `sign` is a governed operation: register only a `sendTransaction` cap rule and every x402 signature dies with `no-applicable-rule`. The fix — an explicit ALLOW for message signing — is now documented in our `buildWdkPolicy()` and friction log.
2. **The npm `wdk-mcp-toolkit` is a placeholder (0.0.0).** We shipped the Agent Skill as an AgentSkills-format `SKILL.md` with MCP-shaped tool schemas instead, so it drops into the toolkit unchanged when it ships.
3. **Making the demo un-fakeable without being fragile.** We wanted judges to type their own attacks: replayed `X-PAYMENT` headers, tampered amounts, impostor keys — each returns a specific 402 code, each is a named test, and the whole session is itself an e2e test asserting the books balance to the micro.

### What we learned
An agent you can trust with money is mostly *not* an AI problem — it's a custody-and-policy problem. Once the wallet itself enforces the cap (WDK) and the payment rail needs no accounts (x402), the model can be small, local, and even wrong sometimes — the blast radius is your cap, and the refusal is the demo's best moment.

### What's next
- **USD₮-native settlement on Spark** as the wallet package exposes it (today: sats at a disclosed 1:1000 demo rate).
- **Voice**: "tip that call" via QVAC Whisper — the SDK surface is already there.
- **Creator directory + reputation** so agents can discover tip jars beyond the demo's known endpoints.

## 3. Team

- **Team Name**: PunditPay
- **Team Description**: Solo build by Edy Cu — spec to shipping in one sprint on the Tether stack. 268 tests / 62 suites green (100% line + function + branch coverage on `src/`, CI-enforced), 6-stage CI, CodeQL + TruffleHog, reproducible p50/p95 benchmarks, 3 runtime dependencies (all Tether SDKs).
- **Nation represented**: ⬜ FILL
- **Teammates + backgrounds**: ⬜ FILL (list every member on the BUIDL page)
- **Team location**: ⬜ FILL
- **Contact to Organizer**: Hi! I'm Edy — I built PunditPay, a fully-local agent that reasons about a match on-device (QVAC) and autonomously tips creators in USD₮ over x402 (WDK), bounded by a hard in-wallet Transaction Policy. Repo: ⬜ FILL · Demo video: ⬜ FILL. `npm run demo` shows the whole loop in ~2 minutes with zero setup. Thank you for reviewing!

## 4. Links

- **GitHub Repository (Apache 2.0)**: ⬜ FILL (push `build/` as the public repo)
- **Live Demo**: runs locally by design (`npm run demo`) — the landing page can be hosted from `landing/`: ⬜ FILL if deployed
- **Pitch/Demo Video (≤3 min, YouTube unlisted)**: ⬜ FILL

## 5. Media

- Logo: `docs/assets/icon-512.png` · Banner: `docs/assets/og-image.png` (1920×1080-safe)
- Screenshots to capture: ① console Terminal mid-reasoning with a green TIP SENT flash ② Guardrails tab (policy + cap) ③ History tab with the red BLOCKED row ④ terminal `npm test` 268/268 ⑤ `verify:offline` output.

## 6. Engineering Harness Summary

| Layer | Status | Details |
|---|---|---|
| Code Quality | ✅ | `node --check` all files + framing/zero-cloud/TODO guards (`npm run lint`) |
| Unit Testing | ✅ | 268 tests / 62 suites, node:test, 100% line + function + branch coverage on `src/` (CI-gated via `npm run coverage`), 0 failures |
| E2E Testing | ✅ | real-HTTP suites: tip-jar attacks + full agent session (`tipjar.e2e`, `agent.e2e`) |
| Security (DevSecOps) | ✅ | CodeQL SAST · Dependabot SCA · TruffleHog secrets · npm audit high |
| CI/CD Pipeline | ✅ | 6 stages: Quality → Security → Build → E2E → Perf → Gate (concurrency-controlled) |
| Performance & Observability | ✅ | `scripts/bench.js` p50/p95 (x402 ≈0.8 ms p50) · bench-results.json artifact |

## 7. Demo Video Script (≤3 min)

1. **0:00–0:20** — The hook: "I never tipped the streamer who called the comeback — the checkout killed the moment. Watch an agent do it with its own keys, on-device."
2. **0:20–0:55** — `npm run demo` + console: the rule (70%) and the cap (1.00). 12' moment declined ("judgment, not a hosepipe"), 23' tip fires — Discover → Sign → Receipt card flashes green with a tx.
3. **0:55–1:25** — Half-time: the agent BUYS a real tactical read via x402 (pay-per-pick). At 63' the read comes true; tip.
4. **1:25–1:55** — The hero beat: 90+2' winner, "confidence 96% > my 70% rule" → TIP SENT. Then FT: one more attempt — **⛔ blocked live by PolicyViolationError**, cap meter at exactly 100%.
5. **1:55–2:25** — Proof sprint: `npm test` (268/268) · `npm run verify:offline` (reasoning with the network tripwired dead) · `--brain=qvac` clip of the real on-device model emitting the tool call.
6. **2:25–3:00** — (spark mode) a real Spark testnet tx on sparkscan + SKILL.md ("any agent can adopt this") — close: "Tipping, never betting. Keys on device. Thank you."
