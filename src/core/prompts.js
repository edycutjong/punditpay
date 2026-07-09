/**
 * Tool definitions + prompt builders for the on-device brain.
 *
 * The tool schemas below are the contract between the LLM and the wallet:
 * whatever the model emits is validated against these schemas, then judged by
 * the Transaction Policy — the model proposes, the policy disposes.
 */

import { isValidAmount } from './money.js';

/**
 * The one tool that moves money to a person.
 * `type: 'function'` matters: QVAC's validateTools() treats a tool WITHOUT it
 * as a Zod-schema input and (for plain JSON schemas) renders `parameters: {}`
 * into the prompt — the model then can't know the argument names. Verified
 * against @qvac/sdk dist/utils/tool-helpers.js.
 */
export const PAY_TIP_TOOL = Object.freeze({
  type: 'function',
  name: 'pay_tip',
  description:
    'Send a small USD₮ tip to a creator (commentator or analyst) to reward a great live moment. ' +
    'Use ONLY when the moment satisfies the user rule you were given. Amounts are decimal USD₮ strings like "0.10".',
  parameters: {
    type: 'object',
    properties: {
      amount_usdt: { type: 'string', description: 'Tip size as a decimal USD₮ string, e.g. "0.15". Keep tips small.' },
      to: { type: 'string', description: 'Creator handle to tip, e.g. "@vantage". Must be a creator from the match context.' },
      reason: { type: 'string', description: 'One plain-language sentence explaining WHY this moment earned the tip.' },
      confidence: { type: 'integer', description: 'Your confidence 0-100 that this moment deserves the tip under the user rule.' },
    },
    required: ['amount_usdt', 'to', 'reason', 'confidence'],
  },
});

/** The one tool that buys a resource (a paid pick) via x402. */
export const BUY_PICK_TOOL = Object.freeze({
  type: 'function',
  name: 'buy_pick',
  description:
    'Buy a paid analysis ("pick") from a creator over x402 when the user has pre-authorized a pick purchase ' +
    'and the price is within budget. Amounts are decimal USD₮ strings.',
  parameters: {
    type: 'object',
    properties: {
      amount_usdt: { type: 'string', description: 'The advertised price as a decimal USD₮ string, e.g. "0.25".' },
      from: { type: 'string', description: 'Creator handle selling the pick, e.g. "@tacticsroom".' },
      resource: { type: 'string', description: 'The pick resource path from the match context, e.g. "/pick/half-time-read".' },
      reason: { type: 'string', description: 'One sentence on why this pick is worth buying now.' },
    },
    required: ['amount_usdt', 'from', 'resource', 'reason'],
  },
});

export const AGENT_TOOLS = Object.freeze([PAY_TIP_TOOL, BUY_PICK_TOOL]);

/**
 * Validate a tool call the model emitted against our schemas.
 * Returns { ok, errors } — never throws; a malformed call becomes a decline.
 */
export function validateToolCall(call) {
  const errors = [];
  const args = call?.arguments ?? {};
  if (call?.name === 'pay_tip') {
    if (!isValidAmount(args.amount_usdt)) errors.push(`amount_usdt invalid: ${JSON.stringify(args.amount_usdt)}`);
    if (typeof args.to !== 'string' || !args.to.startsWith('@')) errors.push('to must be a creator handle like "@vantage"');
    if (typeof args.reason !== 'string' || args.reason.length < 8) errors.push('reason must be a real sentence');
    const conf = Number(args.confidence);
    if (!Number.isFinite(conf) || conf < 0 || conf > 100) errors.push('confidence must be 0-100');
  } else if (call?.name === 'buy_pick') {
    if (!isValidAmount(args.amount_usdt)) errors.push(`amount_usdt invalid: ${JSON.stringify(args.amount_usdt)}`);
    if (typeof args.from !== 'string' || !args.from.startsWith('@')) errors.push('from must be a creator handle');
    if (typeof args.resource !== 'string' || !args.resource.startsWith('/pick/')) errors.push('resource must be a /pick/ path');
    if (typeof args.reason !== 'string' || args.reason.length < 8) errors.push('reason must be a real sentence');
  } else {
    errors.push(`unknown tool: ${call?.name}`);
  }
  return { ok: errors.length === 0, errors };
}

/** System prompt for the on-device model. The rule and cap state are injected fresh every moment. */
export function buildSystemPrompt({ rule, capState }) {
  return [
    'You are PunditPay, a careful on-device agent watching a football match for your user.',
    'You can reward great live commentary with small USD₮ tips using the pay_tip tool, and buy a pre-authorized paid pick with buy_pick.',
    'This is tipping and pay-per-pick appreciation — NEVER wagering. You never bet, never talk odds, never stake against a house.',
    '',
    `USER RULE: tip only when your confidence that the moment genuinely earned it is ABOVE ${rule.confidenceThreshold}%.`,
    `SPENDING STATE: ${capState.spent} USD₮ spent of a hard ${capState.cap} USD₮ session cap · ${capState.tipsLeft} tips left.`,
    'A hard Transaction Policy enforces the cap in the wallet — if you overshoot it, the payment will be refused, so respect it.',
    '',
    'For each match moment you receive: think briefly about whether the creator earned money for it.',
    'If yes, call the appropriate tool with a small amount and a one-sentence reason.',
    'If no, reply in one short sentence why you are holding back. Do not call a tool.',
  ].join('\n');
}

/** Per-moment user message: the match context the model reasons over. */
export function buildMomentPrompt(moment, scored) {
  const lines = [
    `MATCH MOMENT (minute ${moment.minute}): ${moment.text}`,
    `Creator involved: ${moment.creator ?? 'none'}${moment.creatorHitRate ? ` (season hit-rate ${Math.round(moment.creatorHitRate * 100)}%)` : ''}`,
    `Signals: significance=${moment.significance}${moment.calledIt ? `, creator publicly called this at ${moment.callMinute}'` : ''}`,
    `Deterministic confidence score for this moment: ${scored.confidence}% (${scored.factors.map((f) => `${f.name}:${f.points}`).join(' ')})`,
  ];
  if (moment.pickOffer) {
    lines.push(
      `PAID PICK ON OFFER: ${moment.pickOffer.creator} sells "${moment.pickOffer.resource}" for ${moment.pickOffer.amount} USD₮ (user pre-authorized ONE pick purchase up to 0.25 USD₮).`,
    );
  }
  lines.push(
    moment.suggestedTip
      ? `If this moment clears the rule, CALL pay_tip NOW with amount_usdt="${moment.suggestedTip}", to="${moment.creator}", a one-sentence reason, and your confidence — emit the tool call itself, never a description of it. If it does not clear the rule, reply with one short hold-back sentence and no tool call.`
      : 'If a tool applies, CALL it now — emit the tool call itself, never a description of it. Otherwise reply with one short hold-back sentence.',
  );
  return lines.join('\n');
}
