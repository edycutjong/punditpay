# Decision Log

## 2026-07-03T15:30Z — Node ESM + node:test, zero non-Tether runtime deps
**Context**: choose the build's foundation.
**Options considered**: Next.js app · Fastify + Jest · plain Node ESM with node:core only.
**Decision**: plain Node ≥20 ESM; `node:test`, `node:crypto`, `node:http`; runtime deps = the 3 Tether SDKs only.
**Rationale**: the product is an agent + a protocol, not a website. "3 dependencies, all Tether" is itself a judging argument (native stack use), installs in seconds for judges, and removes framework failure surface.

## 2026-07-03T15:32Z — Apache-2.0, not MIT
**Context**: enhance-project template defaults to MIT; the hackathon Rules doc requires Apache 2.0.
**Decision**: Apache-2.0 everywhere (LICENSE, package.json, SKILL.md frontmatter).
**Rationale**: binding rule beats template default.

## 2026-07-03T15:40Z — Default model (SUPERSEDED, see 17:40 entry)
**Context**: spec named `LLAMA_3_2_1B_INST_Q4_0`; the installed SDK exports a dedicated tool-calling 1B.
**Decision (initial)**: default `LLAMA_TOOL_CALLING_1B_INST_Q4_K`.
**Rationale**: a model fine-tuned for tool calls should beat alternatives — a hypothesis we then tested live.

## 2026-07-03T17:40Z — Default model = QWEN3_1_7B_INST_Q4 (decided by measurement)
**Context**: live spikes on the hero moment with three candidates (all cached and runnable via `--model=`).
**Evidence**: qwen-600m → empty-args calls; llama-tools-1b → prose narration of the call, unparseable even with `toolDialect:'pythonic'`; qwen-1.7b → correct structured calls and a full-match run matching the engineered outcome exactly.
**Decision**: default `qwen-1.7b`; keep the other three wired and documented in ARCHITECTURE.md's measured table.

## 2026-07-03T17:30Z — Tool definitions carry top-level `type: 'function'`
**Context**: the model reported seeing `parameters: {}`; calls arrived with missing arguments.
**Root cause**: QVAC `validateTools()` treats a tool without `type:'function'` as a Zod input and reads `.shape` (undefined on plain JSON schema) → silently renders empty parameters into the prompt. Verified in `@qvac/sdk/dist/utils/tool-helpers.js`.
**Decision**: add `type: 'function'` to `PAY_TIP_TOOL`/`BUY_PICK_TOOL`; document in prompts.js, ARCHITECTURE.md, friction log.

## 2026-07-03T18:30Z — Audit round 2: authorization ceiling in the x402 client
**Context**: full-project audit found the client settled whatever the offer demanded; policy only ever saw the model's claimed amount (HIGH severity — real spend could exceed the cap via a lying `buy_pick`).
**Decision**: `payForResource({maxAmountMicros})` refuses offers above the policy-approved amount before settlement; the ledger books the settled (signed) amount with the model's claim kept as `authorizedAmount`. Five smaller findings (500-vs-402 misclassification, null-tolerant shape check, unbounded spent-nonce memory, bigint-crash on malformed amounts, allowlist gap on buy_pick) fixed in the same round — all with named regression tests.
**Rationale**: "the policy disposes" must bind what the wallet SIGNS, not what the model SAYS. Full table in docs/AUDIT_REPORT.md §6.

## 2026-07-03T18:50Z — Audit round 3: console XSS hardening + CLI validation
**Context**: convergence re-audit of surfaces not yet deeply checked (console UI JS, CLI parsing).
**Findings**: (C1) the agent console interpolated a **server-controlled** `explorerUrl` (from a third-party tip jar's receipt — in the product's own threat model) raw into an `href`/`innerHTML` → stored-XSS in the fan's console; (C2) the CLI silently fell back to `rules`/`local` on a typo'd `--brain`/`--wallet`, so `--wallet=sprak` would quietly run local-sim while the operator believed they were on testnet.
**Decision**: (C1) route every ledger value rendered to the DOM through `esc()` + a `safeUrl()` http(s)-only guard; (C2) allowlist known flags + validate `--brain`/`--wallet`/`--pace`/ports, exit 2 on bad input. Both regression-tested (`console-xss.test.js`, `cli.test.js`); suite 192→205.
**Self-inflicted-bug note**: the first CLI fix put `KNOWN_FLAGS` (a `const`) below its call site → temporal-dead-zone ReferenceError that broke *every* invocation. Caught immediately by re-running the CLI matrix before moving on — a reminder to test the tooling change itself, not just the feature.

## 2026-07-03T19:10Z — Audit round 4–5: doc accuracy, fallback hardening, spec reconciliation → CONVERGED
**Round 4**: (D1) `CLAUDE.md` documented the QVAC tool shape without the mandatory `type:'function'` — a future agent would have reintroduced the empty-params bug; fixed with the full shape + warning. (D2) exported + regression-tested the content-channel `<tool_call>` fallback parser (`brain-qvac-fallback.test.js`) — its non-greedy-regex-plus-anchor capture of nested objects is subtle enough that a naive edit could silently drop payments.
**Round 5 (convergence)**: the build required **zero changes**. Only two pre-build planning docs (`../ARCHITECTURE.md`, `../BUILD_PLAN.md`) got contradiction-removing banners (they still described a "fork" plan and the old `LLAMA_3_2_1B` default; the build is original code defaulting to `QWEN3_1_7B` — now pointed at build/DECISIONS.md, matching the earlier SUBMISSION.md treatment).
**Convergence evidence**: 5 audit passes, findings shrinking each round (missing deliverables → MED console XSS + CLI safety → doc/test nits → zero build changes). Final state: 212/212 tests, core money-path 98–100% line coverage, readiness green, real-QVAC verified, every asset/link resolves, spec folder reconciled. Remaining work is human-only (register by Jul 6, repo push, video, testnet tx — build/PROGRESS.md).

## 2026-07-03T17:45Z — Spark TESTNET marked "wired, endpoint-gated" after live test
**Context**: real spike: seed → keys → identity pubkey all fine; operator auth dialed `::1:8536` (local ingress) and refused on a machine without Spark infra (`js-spark-sdk/0.8.8`).
**Decision**: keep the spark adapter as-is (correct per the WDK API); disclose the endpoint caveat in README limitations + friction log; the tx-hash README item stays an explicit human step.
**Rationale**: never let the default demo depend on external availability; never claim on-chain proof that wasn't produced.

## 2026-07-03T15:45Z — Ship SKILL.md, do not depend on wdk-mcp-toolkit
**Context**: spec assumed `wdk-mcp-toolkit`; the npm package is a `0.0.0` placeholder (verified 2026-07-03).
**Decision**: AgentSkills-format `SKILL.md` with MCP-shaped tool schemas; no dependency on the placeholder.
**Rationale**: never depend on vapor; the schemas drop into the real toolkit unchanged when it ships. Disclosed in README + friction log.

## 2026-07-03T15:50Z — x402 implemented natively; @x402/* packages not used
**Context**: real x402 npm packages exist (`@x402/core` etc.) but are EVM/SVM-oriented; settlement here is Spark (or local-sim).
**Decision**: implement the 402→X-PAYMENT→X-PAYMENT-RESPONSE flow natively in `src/core/x402.js` (offer/envelope/canonical-bytes/nonce-store), with pluggable settlement + verification adapters.
**Rationale**: keeps the protocol spec-shaped while letting WDK do settlement; the whole money path stays ~600 auditable LOC. Follows the open x402 spec semantics (402 offer, header names, receipt).

## 2026-07-03T15:55Z — Dual-mode brain and wallet, disclosed everywhere
**Context**: judges must get a zero-setup demo AND real QVAC/Spark proof; testnet + an 0.8 GB model can't be the only path.
**Decision**: `--brain=qvac|rules` and `--wallet=spark|local`; defaults rules+local; every banner/log/doc names the active mode; local settlement hashes are prefixed `sim-` and the network is labeled `local-sim`.
**Rationale**: the un-fakeable version of "works out of the box": nothing pretends to be what it isn't, and each real layer is one flag away.

## 2026-07-03T16:00Z — Tips denominated USD₮, settled in sats at a fixed disclosed demo rate
**Context**: `wdk-wallet-spark` moves sats; the story (and x402 offers) are USD₮.
**Decision**: offers carry `asset: USDT` amounts plus a `settlement` block (1 USD₮ = 1,000 sats, labeled "demo conversion rate, disclosed").
**Rationale**: keeps the product story honest without inventing an oracle; flagged in README limitations + friction log as the roadmap's first item.

## 2026-07-03T16:05Z — E2E = real-HTTP node:test suites, not Playwright
**Context**: enhance-project prescribes Playwright; the product is a CLI/agent/protocol — the browser console is an optional viewer.
**Decision**: E2E = `tipjar.e2e.test.js` + `agent.e2e.test.js` over real sockets (the demo itself run as a test), console verified by HTTP smoke (HTML/SSE/state).
**Rationale**: tests the actual product surface; a Playwright run against a passive SSE viewer would be theater.

## 2026-07-03T16:10Z — Prior-work disclosure corrected: pattern reference, not a fork
**Context**: the spec's draft claimed "we fork qvac-coffee-conversation and reuse its settlement loop." The build is written from scratch.
**Decision**: disclosure now states: pattern proven by Tether's reference; **all PunditPay code is original, written in-window**; only deps are the 3 SDKs.
**Rationale**: the accurate claim is also the stronger one — 100% of the judged work is new.

## 2026-07-03T16:15Z — build/ stays a plain folder inside HermesDocs, pushed later as its own repo
**Context**: hackathon needs a public standalone repo; nesting a git repo inside HermesDocs creates submodule confusion.
**Decision**: `build/` is self-contained (own package.json/LICENSE/README) but not `git init`-ed here; the push step is a PROGRESS item.
**Rationale**: clean copy-out beats nested-repo surgery.

## 2026-07-08T00:00Z — Coverage taken to 100% src lines+functions HONESTLY (pragma live I/O, don't mock it)
**Context**: overall line coverage was ~92% (`src/util/env.js`, `src/server/console.js`, and parts of the QVAC/Spark adapters + several defensive error paths went unmeasured in-process). The honest way up is to test real logic and be explicit about what genuinely can't run in CI — never to mock `@qvac/sdk`/Spark to paint the number green.
**Decision**:
- Added a coverage-completion test suite (`test/env.test.js`, `test/coverage-core.test.js`, `test/console.test.js`, `test/brain-qvac-helpers.test.js`, `test/branch-coverage.test.js`) — 212 → **268 tests / 62 suites**. It drives the real .env parser, the SSE console over real sockets + a capture-sink for the fan-out, the x402 client's discovery/rejection paths via a scripted `fetchImpl`, the NonceStore "expires mid-consume" branch via an advancing clock, the two devsigner verifier catch paths, the tip jar's non-x402→500 path, and the tip jar's spark-config hooks.
- **Branches taken to 100% by direct tests**, not pragmas: each remaining defensive branch is reached by calling the function with its edge input — a txHash-less payment, a scheme mismatch, an unknown-significance moment, a whole-USD₮ `formatMicros`, a payment with no `amountMicros`, a free-resource settlement (null payment/settlement), a mis-configured (empty-network) jar whose `buildOffer` throws an X402Error into `handle()`'s catch, a bigint `settlementFor` value, a default-deny `enforce` (null policy/rule ids), reason-less DENY rules, name/operation-less rule registration, and the malformed `buy_pick` validations. Used `c8` transiently as a branch-level diagnostic (which node's summary doesn't provide), then removed it — the node gate reaches 100/100/100 unaided.
- Exported the QVAC brain's pure helpers (`normalizeArgs`, `normalizeArgKeys`, `stripThinkMarkers`, `extractAfterThink`) and unit-tested them directly, alongside `createQvacBrain` validation and the Spark adapter's pure sats/network/explorer helpers.
- **Pragma, not mock, for true I/O**: the live QVAC model methods (`ready`/`evaluate`/`dispose` → `loadModel`/`completion`/`unloadModel`) and the live Spark wallet (`createSparkWallet`/`sparkVerifier`) are wrapped in single contiguous `/* node:coverage disable */…enable */` blocks with one-line reasons. Contiguous (no enabled islands) is deliberate — a blank/comment line stranded between two disabled regions counts as an uncovered line under `--experimental-test-coverage`.
- **`bin/punditpay.js` excluded from the gate** (`--test-coverage-exclude="bin/**"`): it's the process-bootstrap/wiring entrypoint (argv → stdout → `process.exit`, dynamic Spark import, persistent `.listen`). Its dispatch/validation logic is already exercised by the real-subprocess suite in `test/cli.test.js` + the CI "CLI smoke" stage (subprocess V8 coverage does count via inherited `NODE_V8_COVERAGE`, but its residual lines are live-Spark/live-QVAC/persistent-server that can't flush coverage on kill).
- Gate wired as `npm run coverage` (`--test-coverage-lines=100 --test-coverage-functions=100 --test-coverage-branches=100`) and added to CI Stage 1 + the `ci` npm script.
**Bug found + fixed while testing**: `src/server/tipjar.js` returned `settleAndRespond(...)` **without `await`**, so a non-x402 fault escaped `handle()`'s try/catch as an unhandled rejection — the socket hung instead of returning the intended 500. Added `await` at both call sites; the 500 path is now real and covered.
**Result**: `src/` is **100% lines / 100% functions / 100% branches**; every gap is either tested or a labelled live-I/O pragma. README/submission/pitch numbers updated to match.
**Rationale**: the project's whole thesis is honesty about what's real — coverage has to be earned the same way. A pragma with a reason is an honest "this needs a 1 GB model / testnet funds"; a mock would be a lie that inflates the number.
