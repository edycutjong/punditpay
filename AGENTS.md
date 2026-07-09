# AGENTS.md — PunditPay

## What this is
A fully-local AI agent that reasons about a football match **on-device** (QVAC) and autonomously tips a commentator / buys a pick in **USD₮ over HTTP** (x402), holding its **own self-custodial keys** (WDK), bounded by a hard **Transaction-Policy spend cap**. Tipping / pay-per-pick — never betting.

## Tech stack
| Layer | Technology |
|---|---|
| Runtime | Node.js ≥ 20, ESM, zero non-Tether runtime deps |
| AI brain | `@qvac/sdk` 0.14.1 — `completion()` tool-calling, GGUF models, on-device |
| Wallet / keys | `@tetherto/wdk` beta.12 (Transaction Policies) + `@tetherto/wdk-wallet-spark` beta.22 (zero-fee settlement) |
| Payments | x402 flow (HTTP 402 → signed payment → resource) — native implementation in `src/core/x402.js` |
| Crypto (local mode) | node:crypto ed25519 dev signer |
| Server | node:http (tip jar + console SSE), no framework |
| Tests | node:test (built-in) |

## Design system (from DESIGN_PROMPT.md)
- Canvas `#0B0E11`, panels `#12161C`
- AI reasoning stream: cyan `#38BDF8` (monospace, typing cursor)
- Money / payments: USD₮ green `#26A17B`
- Spend-cap meter: amber `#FFB020`
- Blocked / over-cap: red `#FF4D4F`
- Type: Inter for UI, monospace for reasoning/tx hashes
- Mood: calm, confident agent console — "the machine is thinking and acting"

## Structure
```
bin/punditpay.js       CLI (agent | server | both)
src/core/              pure logic, no I/O: x402, policy, decision, ledger, matchfeed, prompts
src/agent/             brains (qvac real / rules deterministic) + orchestrator
src/wallet/            WDK spark adapter + ed25519 local dev signer
src/server/            x402 tip-jar resource server + console server
console/               self-contained agent console UI (3 screens, SSE)
landing/               one-page explainer
scripts/               bench, verify_offline, check_submission_readiness, demo, keygen, lint
test/                  node:test suites — every invariant
docs/                  audit report, friction log, pitch deck, readme assets
```

## Rules for agents working here
1. Tipping framing only — the lint (`npm run lint`) fails on betting vocabulary in src/.
2. Zero cloud AI — the lint fails on cloud-AI hosts in src/.
3. Never claim unearned numbers (tx hashes, test counts, benchmarks) — `npm run check:readiness` enforces.
4. Apache-2.0. Keys stay on device. Policy cap enforced pre-signature.
