/**
 * Deterministic confidence engine — the agent's football judgment, computable
 * without a network and reproducible in tests.
 *
 * The LLM brain receives these scores as context and reasons over them; the
 * rules brain uses them directly. Either way the user's rule
 * ("tip only when my confidence > threshold") is applied to the same number,
 * so `--brain=rules` and `--brain=qvac` share one notion of confidence.
 */

import { parseUSDT } from './money.js';

/** Factor weights (integer percentage points). Sum of maxima stays ≤ 100. */
const WEIGHTS = {
  base: 20, // any tippable moment starts here
  significance: { low: 0, medium: 12, high: 24 }, // how big was the moment itself
  calledIt: 30, // creator publicly called this outcome before it happened
  callLeadMinutes: 1, // per minute of lead time between call and event (cap 10)
  trackRecord: 16, // scaled by creator's season hit-rate
};

/**
 * Score one match moment for one creator.
 * @returns {{confidence:number, factors:Array<{name:string, points:number, note:string}>}}
 */
export function scoreMoment(moment) {
  const factors = [];
  let confidence = WEIGHTS.base;
  factors.push({ name: 'base', points: WEIGHTS.base, note: 'tippable moment' });

  const sig = WEIGHTS.significance[moment.significance ?? 'low'] ?? 0;
  confidence += sig;
  factors.push({ name: 'significance', points: sig, note: `${moment.significance} significance` });

  if (moment.calledIt) {
    confidence += WEIGHTS.calledIt;
    factors.push({ name: 'called-it', points: WEIGHTS.calledIt, note: `called it at ${moment.callMinute}'` });
    const lead = Math.min(Math.max((moment.minute ?? 0) - (moment.callMinute ?? 0), 0), 10);
    const leadPts = lead * WEIGHTS.callLeadMinutes;
    confidence += leadPts;
    factors.push({ name: 'call-lead', points: leadPts, note: `${lead}' of lead time` });
  }

  const hitRate = clamp01(moment.creatorHitRate ?? 0);
  const trackPts = Math.round(hitRate * WEIGHTS.trackRecord);
  confidence += trackPts;
  factors.push({ name: 'track-record', points: trackPts, note: `${Math.round(hitRate * 100)}% season hit-rate` });

  return { confidence: Math.min(confidence, 99), factors };
}

/**
 * Apply the user's rule to a scored moment.
 * @param {object} moment a matchfeed moment
 * @param {{confidenceThreshold:number, tipAmounts:Record<string,string>}} rule
 * @returns {{confidence:number, shouldTip:boolean, amount:string|null, amountMicros:bigint|null,
 *            reason:string, factors:Array}}
 */
export function evaluateMoment(moment, rule) {
  const { confidence, factors } = scoreMoment(moment);
  const threshold = rule.confidenceThreshold;
  const shouldTip = moment.tippable === true && confidence > threshold;
  const amount = shouldTip ? (moment.suggestedTip ?? rule.tipAmounts?.[moment.significance] ?? '0.10') : null;
  const reason = shouldTip
    ? `${moment.headline} — confidence ${confidence}% > my ${threshold}% rule`
    : moment.tippable
      ? `${moment.headline} — confidence ${confidence}% ≤ my ${threshold}% rule, holding back`
      : `${moment.headline} — not a tippable moment`;
  return {
    confidence,
    shouldTip,
    amount,
    amountMicros: amount ? parseUSDT(amount) : null,
    reason,
    factors,
  };
}

function clamp01(x) {
  return Math.min(Math.max(x, 0), 1);
}
