# DEMO.md — exact steps, expected output

Total time: **~3 minutes** for the default path. No keys, no faucet, no downloads.

## 0. Setup (once)

```bash
git clone https://github.com/edycutjong/punditpay.git && cd punditpay
npm install          # 3 deps: @qvac/sdk, @tetherto/wdk, @tetherto/wdk-wallet-spark
```

## 1. The scripted match (default demo)

```bash
npm run demo
```

What happens, in order — watch both the terminal and the console UI at **http://127.0.0.1:4020**:

| Beat | Minute | Expected log line (verbatim shape) |
|---|---|---|
| the agent states its bounds | — | `🧠 brain: … · 🔑 wallet: … · cap 1.00 USD₮` |
| judgment, not a hosepipe | 12' | `✋ … confidence 32% ≤ my 70% rule, holding back` |
| first autonomous tip | 23' | `✅ Tipped 0.15 USD₮ to @vantage — … called the corner routine · tx …` |
| pay-per-pick via x402 | HT | `✅ Bought pick from @tacticsroom for 0.25 USD₮ …` then `📄 the pick, as purchased: …` |
| the pick comes true | 58'–63' | `✅ Tipped 0.25 USD₮ to @vantage — the overload goal …` |
| **the hero beat** | 90+2' | `⇒ confidence 96% vs rule >70%` → `✅ Tipped 0.25 USD₮ to @vantage — the exact counter @vantage booked at 74'` |
| **the guardrail beat** | FT | `⛔ BLOCKED — PolicyViolationError: would exceed session cap (attempted 0.25 USD₮ to @vantage)` |
| the books balance | — | `✔ done — 4 tips, 1 pick, 1.00 USD₮ spent, 1 blocked, 3 declined` |

In the console UI: the reasoning stream types in cyan, each payment animates the **Discover → Sign → Receipt** card into a green `✓ TIP SENT`, the amber cap meter fills to exactly 100%, and the FT attempt flashes red. The **Guardrails** tab shows the active default-deny policy; **History** lists every payment with its tx and the one red `BLOCKED` row.

## 2. The real on-device model (QVAC track proof)

```bash
npm run demo -- --brain=qvac
```

First run streams `▸ model download …%` (a ~1.1 GB GGUF, cached locally forever after). Then the SAME loop runs, but the reasoning is the model's own streamed prose and the `pay_tip` calls are **emitted by the LLM via QVAC tool-calling** (142 tok/s on an M-series GPU in our runs). Expect the books to differ slightly between runs — a real model exercises judgment (our verified run matched the engineered script exactly; another run skipped the pick and fit a 5th tip exactly on the cap). What never varies: Σ spend ≤ 1.00 USD₮, every payment policy-gated before signing, everything logged. After one full download you can run it in airplane mode — which is the point.

## 3. Real Spark testnet settlement (WDK track proof)

```bash
npm run keygen        # run twice; put phrases in .env as PUNDITPAY_SEED_PHRASE and TIPJAR_SEED_PHRASE
# fund the agent address with testnet sats (address is printed at startup)
npm run demo -- --wallet=spark
```

Tips become real zero-fee Spark transfers; each ledger line carries a real tx hash and a `sparkscan.io` explorer link. The same Transaction-Policy limits are also registered **inside the WDK wallet** (`wdk.registerPolicy`), so the over-cap attempt is refused by the wallet itself.

## 4. The proofs

```bash
npm test                # 212/212 — protocol invariants, attacks, the full session as a test
npm run verify:offline  # network is killed by tripwire → 9 decisions still reached, settlement fails cleanly
npm run bench           # p50/p95: decision µs · x402 round-trip ms · full pipeline ms
npm run lint            # framing guard: betting vocabulary anywhere in src/ FAILS the build
```

## 5. Poke the tip jar yourself (x402 by hand)

```bash
npm run server &
curl -i http://127.0.0.1:4021/tip/@vantage?amount=0.10     # → HTTP/1.1 402 + JSON offer (scheme, amount, payTo, nonce)
curl -s http://127.0.0.1:4021/jar | python3 -m json.tool    # → what each creator received
```

Paying by hand requires signing the offer's canonical bytes — exactly what `src/agent/x402-client.js` does; a judge typing a forged/replayed `X-PAYMENT` header gets `402 bad-signature` / `402 replayed-nonce` back.

## If something goes wrong

- **Port in use**: `--port=…` / `--console-port=…` (defaults 4021 / 4020).
- **`--brain=qvac` on low-RAM machines**: try `--model=qwen-600m` (smallest) — quality drops before honesty does.
- **Spark testnet flaky**: it's testnet + a beta SDK (disclosed); the demo's default path never depends on it.
