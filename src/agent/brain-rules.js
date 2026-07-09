/**
 * Deterministic brain — the decision engine speaking for itself.
 *
 * Used by tests, CI, `verify:offline`, and `--brain=rules`. It shares the
 * exact confidence math with the QVAC brain's prompt context, so both brains
 * agree on WHEN a moment clears the user's rule; the LLM adds judgment and
 * language, this one adds reproducibility. The console banner always states
 * which brain is running — this mode is never passed off as the model.
 */

import { evaluateMoment } from '../core/decision.js';
import { formatUSDT } from '../core/money.js';

export function createRulesBrain() {
  return {
    kind: 'rules',
    label: 'deterministic decision engine (no LLM)',

    async ready() {
      return true;
    },

    /**
     * @param {object} moment a matchfeed moment
     * @param {{rule: {confidenceThreshold:number}, capState: {spentMicros:bigint, capMicros:bigint, tipsLeft:number}}} ctx
     */
    async evaluate(moment, { rule, capState }) {
      const result = evaluateMoment(moment, rule);
      const reasoningLines = [
        `minute ${moment.minute}': ${moment.headline}`,
        ...result.factors.filter((f) => f.points > 0).map((f) => `  +${f.points} ${f.name} (${f.note})`),
        `  ⇒ confidence ${result.confidence}% vs rule >${rule.confidenceThreshold}%`,
      ];

      // A pre-authorized pick offer is handled before tip logic — buying the
      // half-time read is a purchase decision, not a confidence call.
      if (moment.pickOffer) {
        reasoningLines.push(
          `  paid pick on offer: ${moment.pickOffer.resource} at ${moment.pickOffer.amount} USD₮ — user pre-authorized one pick`,
        );
        return {
          reasoningLines,
          toolCall: {
            name: 'buy_pick',
            arguments: {
              amount_usdt: moment.pickOffer.amount,
              from: moment.pickOffer.creator,
              resource: moment.pickOffer.resource,
              reason: 'Pre-authorized half-time read; the seller has the best tactical record in this match.',
            },
          },
          holdBack: null,
        };
      }

      if (!result.shouldTip) {
        return {
          reasoningLines,
          toolCall: null,
          holdBack: result.reason,
        };
      }

      reasoningLines.push(
        `  cap check: ${formatUSDT(capState.spentMicros)} spent of ${formatUSDT(capState.capMicros)} — proposing ${result.amount} USD₮`,
      );
      return {
        reasoningLines,
        toolCall: {
          name: 'pay_tip',
          arguments: {
            amount_usdt: result.amount,
            to: moment.creator,
            reason: result.reason,
            confidence: result.confidence,
          },
        },
        holdBack: null,
      };
    },

    async dispose() {},
  };
}
