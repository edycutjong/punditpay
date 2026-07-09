/**
 * QVAC content-channel fallback parser (audit D2).
 *
 * When a small model leaks its tool call into the CONTENT stream as a literal
 * <tool_call>{json}</tool_call> block instead of the native channel, the brain
 * parses it — and the parsed call still passes the SAME schema validation and
 * policy gate as a native one. The non-greedy regex must nonetheless capture
 * the FULL (nested) object; if a future edit made it stop at the first inner
 * `}`, real payments would silently vanish into "hold-back". This locks that in.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseContentToolCall } from '../src/agent/brain-qvac.js';

describe('brain-qvac: content-channel fallback parser', () => {
  it('captures a full nested-arguments pay_tip (the normal shape)', () => {
    const r = parseContentToolCall([
      '<tool_call>{"name":"pay_tip","arguments":{"amount_usdt":"0.25","to":"@vantage","reason":"called the winner","confidence":90}}</tool_call>',
    ]);
    assert.equal(r.name, 'pay_tip');
    assert.equal(r.arguments.amount_usdt, '0.25');
    assert.equal(r.arguments.to, '@vantage');
    assert.equal(r.arguments.confidence, 90);
  });

  it('captures a call even when wrapped in prose and think tags', () => {
    const r = parseContentToolCall([
      '<think>Confidence is high, I should pay.</think>',
      'Here is my call:',
      '<tool_call>{"name":"buy_pick","arguments":{"amount_usdt":"0.25","from":"@t","resource":"/pick/x","reason":"worth buying now"}}</tool_call>',
    ]);
    assert.equal(r.name, 'buy_pick');
    assert.equal(r.arguments.resource, '/pick/x');
  });

  it('captures deeply-nested arguments without truncating at the first brace', () => {
    const r = parseContentToolCall([
      '<tool_call>{"name":"pay_tip","arguments":{"meta":{"scores":{"x":1}},"amount_usdt":"0.10","to":"@v","reason":"deep nest","confidence":80}}</tool_call>',
    ]);
    assert.equal(r.name, 'pay_tip');
    assert.deepEqual(r.arguments.meta, { scores: { x: 1 } });
    assert.equal(r.arguments.amount_usdt, '0.10');
  });

  it('returns null when there is no tool_call block', () => {
    assert.equal(parseContentToolCall(['just thinking out loud, no call here']), null);
  });

  it('returns null on malformed JSON instead of throwing', () => {
    assert.equal(parseContentToolCall(['<tool_call>{not json}</tool_call>']), null);
  });

  it('returns null when the parsed object has no name', () => {
    assert.equal(parseContentToolCall(['<tool_call>{"arguments":{}}</tool_call>']), null);
  });

  it('tolerates a string or empty input without throwing', () => {
    assert.equal(parseContentToolCall(''), null);
    assert.equal(parseContentToolCall(null), null);
    assert.equal(parseContentToolCall('<tool_call>{"name":"hold","arguments":{}}</tool_call>').name, 'hold');
  });
});
