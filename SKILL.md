---
name: punditpay-tip
description: Pay a small USD₮ tip or buy a paid pick from a creator over x402 (HTTP 402), signed with a self-custodial WDK wallet, bounded by a hard Transaction-Policy spend cap. Use when the user wants to reward a live football moment or purchase a creator's analysis without accounts, cards, or checkouts.
license: Apache-2.0
---

# PunditPay Tip — Agent Skill

Teach any agent to reward humans with real money, safely.

> Published as an [AgentSkills](https://agentskills.io)-format `SKILL.md` (the npm `@tetherto/wdk-mcp-toolkit` package is a placeholder at time of writing — when it ships, these tools drop in unchanged as MCP tools; the schemas below are already MCP-shape).

## Tools this skill provides

### `pay_tip`
Send a small USD₮ tip to a creator for a live moment that earned it.

```json
{
  "name": "pay_tip",
  "description": "Send a small USD₮ tip to a creator (commentator or analyst) to reward a great live moment. Use ONLY when the moment satisfies the user rule you were given.",
  "parameters": {
    "type": "object",
    "properties": {
      "amount_usdt": { "type": "string", "description": "Decimal USD₮ string, e.g. \"0.15\". Keep tips small." },
      "to":          { "type": "string", "description": "Creator handle, e.g. \"@vantage\"." },
      "reason":      { "type": "string", "description": "One plain-language sentence explaining WHY this moment earned it." },
      "confidence":  { "type": "integer", "description": "Your confidence 0-100 under the user's rule." }
    },
    "required": ["amount_usdt", "to", "reason", "confidence"]
  }
}
```

### `buy_pick`
Buy a paid analysis over x402 when the user pre-authorized it and the price is within budget.

```json
{
  "name": "buy_pick",
  "description": "Buy a paid analysis (a 'pick') from a creator over x402.",
  "parameters": {
    "type": "object",
    "properties": {
      "amount_usdt": { "type": "string" },
      "from":        { "type": "string", "description": "Creator handle selling the pick." },
      "resource":    { "type": "string", "description": "The pick path, e.g. \"/pick/half-time-read\"." },
      "reason":      { "type": "string" }
    },
    "required": ["amount_usdt", "from", "resource", "reason"]
  }
}
```

## How to execute a tool call (the x402 loop)

```js
import { payForResource } from 'punditpay/src/agent/x402-client.js';

// pay_tip → GET {tipjar}/tip/@handle?amount=0.15
// buy_pick → GET {tipjar}{resource}
const { resource, receipt } = await payForResource({
  baseUrl: TIPJAR_URL,
  path: `/tip/${args.to}?amount=${args.amount_usdt}`,
  wallet, // any adapter exposing settle(offer) · signBytes(bytes) · getAddress()
});
```

The client handles the whole flow: `402` offer → wallet settlement → canonical-bytes signature → paid retry with `X-PAYMENT` → resource + `X-PAYMENT-RESPONSE` receipt.

Wallet adapters included:
- **`createSparkWallet()`** — real self-custodial WDK keys, zero-fee Spark transfers (TESTNET/MAINNET), explorer links.
- **`createLocalWallet()`** — ed25519 dev signer for development; settlement honestly labeled `local-sim`.

## Guardrails (non-negotiable)

1. **Never call these tools outside the user's rule.** The user sets a confidence threshold; below it, hold back and say why in one sentence.
2. **The Transaction Policy is law.** A hard session cap, per-tip max, tip-count limit, and (optionally) a recipient allowlist are enforced BEFORE any signature — expect and surface `PolicyViolationError`, never route around it:

```js
import { PolicyEngine, buildTipPolicy } from 'punditpay/src/core/policy.js';
const policy = new PolicyEngine().registerPolicy(buildTipPolicy({
  sessionCapMicros: 1_000_000n,   // 1.00 USD₮
  maxTipMicros:       250_000n,   // 0.25 USD₮
  maxTips: 6, maxPickMicros: 250_000n, maxPicks: 1,
}, ledger.session));
await policy.enforce('pay_tip', { amountMicros, to });  // throws PolicyViolationError on DENY
```

3. **Tipping, never wagering.** This skill rewards people. It must never be used to stake against an outcome, quote odds, or interact with a book.
4. **Log everything in plain language.** Every payment: amount, recipient, one-sentence reason, tx hash. Every refusal: the rule that fired.

## Wiring it into a WDK wallet (second enforcement layer)

```js
import WDK from '@tetherto/wdk';
import WalletManagerSpark from '@tetherto/wdk-wallet-spark';
import { buildWdkPolicy } from 'punditpay/src/core/policy.js';

const wdk = new WDK(seedPhrase)
  .registerWallet('spark', WalletManagerSpark, { network: 'TESTNET' })
  .registerPolicy(buildWdkPolicy({ sessionCapSettleUnits: 1000n }, session));
```

Note: WDK's policy engine is **default-deny** on governed accounts and `sign` is a governed operation — `buildWdkPolicy` therefore includes an explicit ALLOW for message signing (x402 signatures move no funds), or your payment envelope can never be signed.
