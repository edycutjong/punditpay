# Why ONLY QVAC + WDK — PunditPay (as built)

An AI that reasons on your device and pays a human over plain HTTP — with its own self-custodial keys and a spend cap it cannot breach — needs both sponsors and needs them deeply. Every method below is a real call site in this repo, not a talking point.

## QVAC features used (on-device brain — 6)

| # | Feature | Where (file:line) | What it buys us |
|---|---|---|---|
| 1 | `loadModel({ modelSrc, modelType:'llm', modelConfig:{ ctx_size, tools:true } })` | `src/agent/brain-qvac.js:59` | The whole brain is a local file. Without it: an API key and a rate limit. |
| 2 | `completion({ modelId, history, stream, tools, toolDialect })` **with tool-calling** | `src/agent/brain-qvac.js:87` | The *model* decides to pay by emitting `pay_tip`, not a human clicking a button. |
| 3 | Streaming via `run.tokenStream` / `run.toolCallStream` / `await run.toolCalls` | `src/agent/brain-qvac.js:91` | The reasoning is watchable live and the structured call is parsed out of the same stream — the demo's whole left panel. |
| 4 | Model constants (`QWEN3_1_7B_INST_Q4`, `LLAMA_TOOL_CALLING_1B_INST_Q4_K`, `QWEN3_600M_INST_Q4`) | `src/agent/brain-qvac.js:21-24` | One import per model; `--model=` swaps sizes. Setup stays one line. |
| 5 | On-device inference (zero cloud) — proven by `scripts/verify_offline.js` | tripwire kills `fetch`+sockets | Your tipping logic and history never touch someone's server. |
| 6 | `unloadModel({ modelId, clearStorage:false })` | `src/agent/brain-qvac.js:137` | Clean lifecycle; the cached weights survive for the next airplane-mode run. |

**Integration fact we paid for in blood** (`docs/friction-log.md` §8): tool definitions must carry top-level `type:'function'` or QVAC's `validateTools()` treats `parameters` as a Zod schema, reads `.shape` → `undefined`, and silently renders `parameters:{}` into the prompt — the model literally cannot see the argument names. Root-caused in `node_modules/@qvac/sdk/dist/utils/tool-helpers.js`; the fix is `src/core/prompts.js` (`type:'function'` on both tools).

## WDK features used (keys + payment + guardrail — 6)

| # | Feature | Where (file:line) | What it buys us |
|---|---|---|---|
| 1 | Self-custodial `new WDK(seed).registerWallet('spark', WalletManagerSpark, …)` | `src/wallet/wdk-spark.js:50` | The agent owns its wallet; BIP-39 keys live on the device. |
| 2 | **Transaction Policies** `wdk.registerPolicy(...)` → in-wallet cap | `src/wallet/wdk-spark.js:53` | The spend cap is enforced *inside the wallet*, not in a server you must trust. |
| 3 | `PolicyViolationError` (semantics mirrored in our pre-flight engine) | `src/core/policy.js:17,111` | Bounded autonomy with a structured, catchable refusal — the demo's red beat. |
| 4 | `account.sign(msg)` + read-only `account.verify(msg, sig)` | `src/wallet/wdk-spark.js:75,121` | Powers the x402 payment envelope; the server verifies with no keys. |
| 5 | `account.sendTransaction({ to, value })` on **Spark** (zero-fee) + `getTransactionReceipt` | `src/wallet/wdk-spark.js:84,124` | Zero-fee settlement makes $0.05 tips economical; receipt confirms on-chain existence. |
| 6 | `WDK.getRandomSeedPhrase()` / `WDK.isValidSeed()` | `scripts/keygen.js:12`, `src/wallet/wdk-spark.js:48` | Key generation and validation without hand-rolling BIP-39. |

**Integration fact** (`docs/friction-log.md` §1): WDK is default-deny on governed accounts and `sign` is a governed operation — a cap policy that only addresses `sendTransaction` silently breaks x402 signing with `no-applicable-rule`. Fixed by an explicit `sign` ALLOW rule in `buildWdkPolicy` (`src/core/policy.js:256`).

## x402 (the handshake that removes the accounts)

The open x402 flow — `402` offer → `X-PAYMENT` → resource + `X-PAYMENT-RESPONSE` — is implemented natively in `src/core/x402.js` (offer/envelope/canonical-signing-bytes/nonce-store) so WDK does settlement while the protocol stays spec-shaped. The payment *is* the credential; neither side has an account.

## Honest limitations of the sponsor tech

- **`@tetherto/wdk` is `1.0.0-beta.12`** — pinned; test before relying.
- **`wdk-wallet-spark` moves sats, not USD₮ (yet)** — tips are USD₮-denominated and settle in sats at a fixed, disclosed demo rate (1 USD₮ = 1,000 sats).
- **Spark TESTNET operator auth was endpoint-gated** in the `js-spark-sdk@0.8.8` build we tested (dialed a local ingress) — keys derive fine, public-testnet access needs newer endpoint config; disclosed in `docs/friction-log.md` §7.
- **`@tetherto/wdk-mcp-toolkit` is a `0.0.0` placeholder** on npm — so the Agent Skill ships as `SKILL.md` (MCP-shaped) rather than an MCP dependency.

## Closing

**Take QVAC + WDK out and you'd need:** a cloud LLM + API key, a payment processor, an account system, a checkout UI, a custodial wallet service, and a server-side limits engine — **six systems and a data-sharing agreement** — to do what one on-device agent does here in a single HTTP round-trip. PunditPay has **three** runtime dependencies, all Tether, and every one is load-bearing.
