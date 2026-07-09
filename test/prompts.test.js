import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_TOOLS, BUY_PICK_TOOL, PAY_TIP_TOOL, buildMomentPrompt, buildSystemPrompt, validateToolCall } from '../src/core/prompts.js';

describe('prompts: tool schemas', () => {
  it('exposes exactly two tools to the model', () => assert.equal(AGENT_TOOLS.length, 2));

  it('pay_tip parameters are a valid JSON-schema object', () => {
    assert.equal(PAY_TIP_TOOL.parameters.type, 'object');
    assert.deepEqual(PAY_TIP_TOOL.parameters.required, ['amount_usdt', 'to', 'reason', 'confidence']);
    for (const key of PAY_TIP_TOOL.parameters.required) {
      assert.ok(PAY_TIP_TOOL.parameters.properties[key], `missing property ${key}`);
    }
  });

  it('buy_pick parameters are a valid JSON-schema object', () => {
    assert.equal(BUY_PICK_TOOL.parameters.type, 'object');
    assert.deepEqual(BUY_PICK_TOOL.parameters.required, ['amount_usdt', 'from', 'resource', 'reason']);
  });

  it('tool descriptions carry the framing guard (tipping, not wagering)', () => {
    assert.match(PAY_TIP_TOOL.description, /tip/i);
    assert.doesNotMatch(PAY_TIP_TOOL.description, /\bwager|\bodds|\bgambl/i);
  });
});

describe('prompts: validateToolCall accepts well-formed calls', () => {
  it('accepts a valid pay_tip', () => {
    const { ok, errors } = validateToolCall({
      name: 'pay_tip',
      arguments: { amount_usdt: '0.15', to: '@vantage', reason: 'called the corner routine before it happened', confidence: 88 },
    });
    assert.deepEqual(errors, []);
    assert.equal(ok, true);
  });

  it('accepts a valid buy_pick', () => {
    const { ok } = validateToolCall({
      name: 'buy_pick',
      arguments: { amount_usdt: '0.25', from: '@tacticsroom', resource: '/pick/half-time-read', reason: 'pre-authorized half-time read' },
    });
    assert.equal(ok, true);
  });
});

describe('prompts: validateToolCall rejects malformed calls (the model cannot invent money)', () => {
  it('rejects an unknown tool name', () => {
    assert.equal(validateToolCall({ name: 'transfer_everything', arguments: {} }).ok, false);
  });
  it('rejects a bad amount', () => {
    assert.equal(validateToolCall({ name: 'pay_tip', arguments: { amount_usdt: 'lots', to: '@v', reason: 'a good long reason', confidence: 90 } }).ok, false);
  });
  it('rejects a negative amount', () => {
    assert.equal(validateToolCall({ name: 'pay_tip', arguments: { amount_usdt: '-0.10', to: '@vantage', reason: 'a good long reason', confidence: 90 } }).ok, false);
  });
  it('rejects a recipient without @', () => {
    assert.equal(validateToolCall({ name: 'pay_tip', arguments: { amount_usdt: '0.10', to: 'vantage', reason: 'a good long reason', confidence: 90 } }).ok, false);
  });
  it('rejects a one-word reason', () => {
    assert.equal(validateToolCall({ name: 'pay_tip', arguments: { amount_usdt: '0.10', to: '@vantage', reason: 'nice', confidence: 90 } }).ok, false);
  });
  it('rejects out-of-range confidence', () => {
    assert.equal(validateToolCall({ name: 'pay_tip', arguments: { amount_usdt: '0.10', to: '@vantage', reason: 'a good long reason', confidence: 140 } }).ok, false);
  });
  it('rejects a pick resource outside /pick/', () => {
    assert.equal(validateToolCall({ name: 'buy_pick', arguments: { amount_usdt: '0.25', from: '@t', resource: '/tip/@vantage', reason: 'a good long reason' } }).ok, false);
  });
  it('rejects a null call', () => {
    assert.equal(validateToolCall(null).ok, false);
  });
});

describe('prompts: prompt builders', () => {
  it('system prompt embeds the rule threshold and cap state', () => {
    const p = buildSystemPrompt({ rule: { confidenceThreshold: 70 }, capState: { spent: '0.40', cap: '1.00', tipsLeft: 4 } });
    assert.match(p, /ABOVE 70%/);
    assert.match(p, /0\.40 USD₮ spent of a hard 1\.00 USD₮ session cap/);
    assert.match(p, /NEVER wagering/);
  });

  it('moment prompt embeds the deterministic confidence for grounding', () => {
    const p = buildMomentPrompt(
      { minute: 23, text: 'GOAL', creator: '@vantage', creatorHitRate: 0.78, significance: 'high', calledIt: true, callMinute: 21 },
      { confidence: 88, factors: [{ name: 'base', points: 20 }] },
    );
    assert.match(p, /confidence score for this moment: 88%/);
    assert.match(p, /@vantage/);
  });

  it('moment prompt advertises a pick offer when present', () => {
    const p = buildMomentPrompt(
      { minute: 46, text: 'HT', creator: null, significance: 'low', pickOffer: { creator: '@tacticsroom', resource: '/pick/half-time-read', amount: '0.25' } },
      { confidence: 10, factors: [] },
    );
    assert.match(p, /PAID PICK ON OFFER/);
  });
});
