/**
 * The PunditPay agent — one loop, extreme depth:
 *
 *   match moment → on-device brain → tool call?
 *        → schema validation → Transaction-Policy gate (pre-flight)
 *        → x402: discover price → settle → sign → resource + receipt
 *        → plain-language ledger entry (with tx hash)
 *
 * A PolicyViolationError is not an error here — it is the product working:
 * the moment the wallet says "no" to its own agent, logged in red.
 */

import { evaluateMoment } from '../core/decision.js';
import { formatUSDT, parseUSDT } from '../core/money.js';
import { PolicyEngine, PolicyViolationError, buildTipPolicy } from '../core/policy.js';
import { AGENT_TOOLS, validateToolCall } from '../core/prompts.js';
import { describeBlocked, describePayment } from '../core/ledger.js';
import { payForResource } from './x402-client.js';

export const DEFAULT_RULE = Object.freeze({
  confidenceThreshold: 70,
  tipAmounts: { low: '0.05', medium: '0.10', high: '0.25' },
});

export const DEFAULT_LIMITS = Object.freeze({
  sessionCap: '1.00',
  maxTip: '0.25',
  maxTips: 6,
  maxPick: '0.25',
  maxPicks: 1,
});

/**
 * @param {{feed: Array, brain: object, wallet: object, ledger: import('../core/ledger.js').ActionLedger,
 *          tipjarUrl: string, rule?: object, limits?: object, fetchImpl?: typeof fetch,
 *          paceMs?: number, allowedRecipients?: string[]}} opts
 */
export function createAgent({ feed, brain, wallet, ledger, tipjarUrl, rule = DEFAULT_RULE, limits = DEFAULT_LIMITS, fetchImpl = fetch, paceMs = 0, allowedRecipients }) {
  const capMicros = parseUSDT(limits.sessionCap);
  const policy = new PolicyEngine().registerPolicy(
    buildTipPolicy(
      {
        sessionCapMicros: capMicros,
        maxTipMicros: parseUSDT(limits.maxTip),
        maxTips: limits.maxTips,
        maxPickMicros: parseUSDT(limits.maxPick),
        maxPicks: limits.maxPicks,
        allowedRecipients,
      },
      ledger.session,
    ),
  );

  function capState() {
    return {
      spentMicros: ledger.spentMicros(),
      capMicros,
      tipsLeft: Math.max(limits.maxTips - ledger.tipCount(), 0),
    };
  }

  async function processMoment(moment) {
    ledger.append('info', moment.text, { minute: moment.minute, type: moment.type, seq: moment.seq });

    const worthEvaluating = moment.tippable || moment.pickOffer;
    if (!worthEvaluating) return null;

    const evaluated = await brain.evaluate(moment, { rule, capState: capState() });
    for (const line of evaluated.reasoningLines) {
      ledger.append('reasoning', line, { minute: moment.minute, seq: moment.seq, brain: brain.kind });
    }

    if (!evaluated.toolCall) {
      ledger.append('decision', evaluated.holdBack ?? 'held back', {
        minute: moment.minute,
        seq: moment.seq,
        confidence: evaluateMoment(moment, rule).confidence,
      });
      return null;
    }

    return executeToolCall(evaluated.toolCall, moment);
  }

  async function executeToolCall(toolCall, moment) {
    const validation = validateToolCall(toolCall);
    if (!validation.ok) {
      ledger.append('error', `rejected malformed tool call ${toolCall.name}: ${validation.errors.join('; ')}`, {
        seq: moment.seq,
        toolCall,
      });
      return null;
    }

    const isTip = toolCall.name === 'pay_tip';
    const args = toolCall.arguments;
    const amountMicros = parseUSDT(args.amount_usdt);
    const recipient = isTip ? args.to : args.from;
    const params = { amountMicros, to: recipient, reason: args.reason };

    // ── The guardrail: policy verdict BEFORE any signature ──
    try {
      await policy.enforce(toolCall.name, params);
    } catch (err) {
      if (err instanceof PolicyViolationError) {
        const text = describeBlocked({ amount: args.amount_usdt, to: recipient, reason: err.reason });
        ledger.append('blocked', text, {
          minute: moment.minute,
          seq: moment.seq,
          operation: toolCall.name,
          amount: args.amount_usdt,
          amountMicros,
          to: recipient,
          policyId: err.policyId,
          ruleName: err.ruleName,
          reason: err.reason,
        });
        return { blocked: true, error: err };
      }
      throw err;
    }

    // ── x402: discover → settle → sign → resource ──
    // The policy-approved amount is a hard ceiling for the client: an offer
    // demanding more than the authorization is refused before any signature,
    // so the books below can never under-record what actually left the wallet.
    const path = isTip ? `${pathForTip(recipient)}?amount=${encodeURIComponent(args.amount_usdt)}` : args.resource;
    try {
      const outcome = await payForResource({ baseUrl: tipjarUrl, path, wallet, fetchImpl, maxAmountMicros: amountMicros });
      // Ledger truth = the SIGNED payment, not the model's claim.
      const settledAmount = outcome.payment?.amount ?? args.amount_usdt;
      const settledMicros = outcome.payment ? parseUSDT(outcome.payment.amount) : amountMicros;
      const text = describePayment({
        operation: toolCall.name,
        amount: settledAmount,
        to: recipient,
        reason: args.reason,
        txHash: outcome.settlement?.txHash,
      });
      ledger.append('payment', text, {
        minute: moment.minute,
        seq: moment.seq,
        operation: toolCall.name,
        amount: settledAmount,
        amountMicros: settledMicros,
        authorizedAmount: args.amount_usdt,
        to: recipient,
        reason: args.reason,
        confidence: args.confidence ?? null,
        txHash: outcome.settlement?.txHash ?? null,
        network: outcome.settlement?.network ?? wallet.network,
        explorerUrl: outcome.receipt?.explorerUrl ?? outcome.settlement?.explorerUrl ?? null,
        timings: outcome.timings,
        resource: isTip ? null : outcome.resource,
      });
      if (!isTip && outcome.resource?.content) {
        ledger.append('info', `📄 the pick, as purchased: “${outcome.resource.content.slice(0, 140)}…”`, { seq: moment.seq });
      }
      return { paid: true, outcome };
    } catch (err) {
      ledger.append('error', `settlement failed for ${toolCall.name} → ${recipient}: ${err.message}`, {
        seq: moment.seq,
        code: err.code ?? null,
      });
      return { failed: true, error: err };
    }
  }

  return {
    policy,
    rule,
    limits,
    capState,

    /** Run the whole scripted session. */
    async runSession() {
      ledger.append('info', `🧠 brain: ${brain.label} · 🔑 wallet: ${wallet.label} (${wallet.network}) · cap ${limits.sessionCap} USD₮`, {
        brain: brain.kind,
        wallet: wallet.kind,
      });
      await brain.ready();
      for (const moment of feed) {
        await processMoment(moment);
        if (paceMs > 0) await sleep(paceMs);
      }
      const summary = ledger.summary();
      ledger.append(
        'info',
        `session over: ${summary.tips} tips + ${summary.picks} pick = ${summary.spent} USD₮ spent · ${summary.blocked} blocked by policy · ${summary.declined} moments declined`,
        { summary },
      );
      return summary;
    },

    processMoment,
    executeToolCall,
  };
}

export function pathForTip(handle) {
  return `/tip/${handle}`;
}

export { AGENT_TOOLS };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
