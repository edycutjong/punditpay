# Self-Audit — PunditPay

An honest map of what this system defends against, what it doesn't, and how each claim is tested. Written the way we'd want to receive it.

## 1. Assets & trust model

| Asset | Held by | Trusted with |
|---|---|---|
| Agent seed phrase / keys | the user's device only (WDK / node:crypto) | everything — custody is the product |
| Session budget (≤ cap) | the agent, bounded by policy | the agent's judgment, bounded |
| Tip-jar receipts | the creator's server | correctness of its own accounting |
| The LLM's output | **nothing** — treated as untrusted input | proposes only; validated + policy-gated |

The core stance: **the model is inside the threat model.** A hallucinating, jailbroken, or hostile brain must not be able to move more money than the policy allows, pay unknown parties (when allowlisted), or bypass validation.

## 2. Invariants and where they're enforced/tested

| # | Invariant | Enforced in | Tested in |
|---|---|---|---|
| I1 | Σ session spend ≤ cap, checked BEFORE signing | `policy.js` `block-over-cap` + WDK in-wallet policy | `policy.test.js`, `agent.e2e.test.js` |
| I2 | Default-deny: unaddressed operations are refused | `PolicyEngine.simulate` | `policy.test.js` ("send_all_funds" case) |
| I3 | Keys never leave the device | adapters expose `signBytes()` only; no key serialization anywhere | code review + `devsigner.test.js` |
| I4 | Payments bind to offer: network, asset, payTo, resource, nonce, amount | `x402.js verifyPayment` | `x402.test.js` (7 mismatch cases) |
| I5 | No replay: nonces are single-use with TTL | `NonceStore` | `x402.test.js`, `tipjar.e2e.test.js` |
| I6 | No impostor: address ↔ pubkey binding (local) / read-only verify + tx receipt (spark) | `devsigner.localVerifier`, `wdk-spark.sparkVerifier` | `devsigner.test.js`, `tipjar.e2e.test.js` |
| I7 | Malformed tool calls die before policy/settlement | `prompts.validateToolCall` | `prompts.test.js`, `agent.e2e` hostile suite |
| I8 | Blocked/failed attempts record zero spend | ledger accounting (payments only) | `ledger.test.js`, `agent.e2e.test.js` |
| I9 | Reasoning requires no network | pure `src/core` + local model file | `scripts/verify_offline.js` (tripwire) |

## 3. Attack walkthroughs (all implemented as tests)

- **Hostile brain says `pay_tip("all of it")`** → schema validation error entry, no policy consult, no payment. ✅
- **Hostile brain invents `sweep_wallet` tool** → unknown-tool rejection; even if it reached policy: default-deny. ✅
- **Hostile brain tips 0.99 to a real creator** → `PolicyViolationError` `block-over-per-tip-max`, zero spend. ✅
- **Redirect to `@moneymule`** (allowlist configured) → `block-unknown-recipient`. ✅
- **Wire attacker tampers the amount after signing** → canonical-bytes signature mismatch → `402 bad-signature`. ✅
- **Replay a captured `X-PAYMENT` header** → `402 replayed-nonce`. ✅
- **Impostor signs with their own key for a victim address** → address↔pubkey binding fails. ✅
- **Tip jar dies mid-match** → error ledger entry, agent continues, zero spend recorded. ✅

## 4. What we do NOT defend against (residual risk)

- **A malicious tip-jar operator** can advertise a price and deliver a worthless resource. Mitigation: per-resource budgets + the cap bound the loss to cents; reputation/discovery is out of scope.
- **Device compromise.** Keys are on-device; an attacker with local code execution owns them. (True of every self-custodial wallet.)
- **The demo rate (1 USD₮ = 1,000 sats) is fixed**, not an oracle. Disclosed; a production build would quote at settlement time.
- **Spark testnet availability** — a beta SDK on a testnet; the default demo path deliberately has zero dependence on it.
- **LLM prompt injection via match feed**: the feed is local fixture data in the demo. A production feed would be untrusted input to the model — but note the *worst case* under I1/I2/I7 remains "spends up to the user's cap on the allowlist," which is the design's whole point.

## 5. Dependency posture

- Runtime deps: **3** (`@qvac/sdk`, `@tetherto/wdk`, `@tetherto/wdk-wallet-spark`), all pinned exact, all Apache-2.0, all Tether-official.
- Everything else is node:core (`crypto`, `http`, `test`). Zero framework surface.
- CI runs `npm audit --audit-level=high`, TruffleHog secret scan, and CodeQL SAST on every push.

## 6. Audit round 2 (2026-07-03) — findings and fixes

A second full-project audit (fresh re-runs + line-level re-read of the money path + claims-vs-reality sweep) found and fixed:

| # | Severity | Finding | Fix | Regression test |
|---|---|---|---|---|
| B9 | **HIGH** | The x402 client settled whatever the 402 offer demanded, unbounded by the policy-approved amount — a `buy_pick` quoting 0.01 against a 0.25 pick passed policy at 0.01 while 0.25 left the wallet, and the ledger under-recorded (real spend could exceed the cap) | `payForResource` now takes `maxAmountMicros`; an offer above the authorization throws `offer-exceeds-authorization` **before any signature**; the ledger records the **settled** amount from the signed payment | `agent.e2e` "cheap-pick authorization attack" + "ledger records the SETTLED amount" |
| B2 | MED | A signed payment with a garbage `amount` threw `MoneyError` inside `verifyPayment` → tip jar answered **500** instead of 402 | wrapped in `X402Error('malformed-payment')` | `tipjar.e2e` "garbage amount is a 402…" + unit test |
| B1 | LOW | `decodePayment` accepted `null`/`''` for non-signature required fields (harmless downstream but misclassified errors) | strict presence check for all ten fields | `x402` "rejects null and empty required fields" |
| B3 | LOW | `NonceStore.spent` grew unboundedly on a long-running jar | spent entries carry timestamps and are GC'd after TTL (replays then refuse as `unknown-nonce`) | `x402` "spent-nonce memory is bounded" |
| B5 | LOW | A non-bigint `amountMicros` crashed bigint arithmetic inside DENY conditions (fail-closed crash; unreachable via the agent) | type-safe conditions + explicit `block-malformed-amount` DENY rule | `policy` "malformed amounts are DENIED without throwing" |
| B7 | LOW | The recipient allowlist governed `pay_tip` only (a hostile `buy_pick` could misattribute, though money could only reach the known jar) | allowlist condition added to `buy_pick`; `block-unknown-recipient` widened to `*` | `policy` "allowlist also governs buy_pick" |

Doc corrections in the same round: test count 183→**191** everywhere (the readiness gate caught the drift by design), bench figures restated as representative ≈values (run-to-run variance measured at ±15%), submission char counts corrected to measured values (Vision 199/256, Pitch 138/150), money-path LOC corrected to ≈880, and the spec-folder draft's "fork" claim corrected to the build's original-code reality.

One deliberate behavior confirmed (not a bug): the tip jar burns an offer's nonce **before** signature verification, so a failed payment attempt forces fresh price discovery — conservative by design.

## 6b. Audit round 3 (2026-07-03) — console + CLI hardening

| # | Severity | Finding | Fix | Regression test |
|---|---|---|---|---|
| C1 | MED | The agent console rendered a **server-controlled** `explorerUrl` (a third-party tip jar's receipt value — a "malicious tip-jar operator" is already named in §4) raw into an `href`/`innerHTML` → stored XSS in the fan's console | every DOM-bound ledger value routed through `esc()` (HTML-escape) + `safeUrl()` (http(s)-only, else rendered inert) | `console-xss.test.js` (5) — source-level guard proving the raw interpolation cannot return |
| C2 | LOW | The CLI silently fell back to `rules`/`local` on a typo'd flag — `--wallet=sprak` would run local-sim while the operator believed they were on testnet | known-flag allowlist + `--brain`/`--wallet`/`--pace`/port validation, exit 2 on bad input | `cli.test.js` (8) — spawns the CLI, asserts exit codes for good and bad input |

**Confirmed race-free (round 3 probe → test):** 10 identical signed payments fired concurrently settle exactly once (nonce burned synchronously before async verify) — `tipjar.e2e` "no double-spend race".

**Concurrency/injection surfaces probed clean:** money round-trip across the full range + extremes, canonical-bytes key-order independence with `fromPublicKey`, and — as of the coverage-completion pass — **100% line + 100% function + 100% branch coverage across all of `src/`**, enforced by `npm run coverage`. The SSE console server is now covered over real sockets; the only unmeasured code is honestly labelled: the live QVAC model calls and the Spark testnet wallet are `node:coverage`-disabled with one-line reasons (they need a ~1GB model / testnet funds, proven by the manual `--brain=qvac` / `--wallet=spark` runs), and the `bin/` CLI is excluded from the gate as pure process-bootstrap, exercised by the real-subprocess CLI suite + CI smoke.

## 7. Verdict

The money-moving path is small (≈880 LOC across `x402.js`, `policy.js`, `money.js`, the wallet adapters, and the x402 client), pure where it matters, and every invariant above is enforced by construction and re-checked by a named test. The honest gap between demo and production is settlement realism (testnet/sim vs mainnet) and vendor discovery — both disclosed everywhere they could mislead.
