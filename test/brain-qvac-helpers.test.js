/**
 * The pure, on-device-model-free surface of the QVAC brain + Spark adapter.
 *
 * The live SDK calls (loadModel/completion/inference in brain-qvac.js, and the
 * @tetherto/wdk wallet in wdk-spark.js) are coverage-disabled with reasons —
 * they need a ~1GB model or testnet funds and are proven by the manual
 * `--brain=qvac` / `--wallet=spark` runs. But the argument-normalizers, the
 * think-tag strippers, the model-name validation, and the sats/network/explorer
 * helpers are plain functions, and THOSE are pinned here — no SDK mock anywhere.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MODEL,
  MODEL_CHOICES,
  createQvacBrain,
  extractAfterThink,
  normalizeArgKeys,
  normalizeArgs,
  stripThinkMarkers,
} from '../src/agent/brain-qvac.js';
import { SATS_PER_USDT, explorerUrlFor, microsToSats, sparkNetworkName } from '../src/wallet/wdk-spark.js';
import { MICROS_PER_USDT } from '../src/core/money.js';

describe('brain-qvac: factory validation', () => {
  it('builds a brain for a known model and exposes its labelled identity', () => {
    const brain = createQvacBrain({ model: 'qwen-1.7b', tools: [] });
    assert.equal(brain.kind, 'qvac');
    assert.match(brain.label, /QWEN3_1_7B_INST_Q4/);
    assert.equal(brain.stats(), null, 'no stats until the model has actually run');
  });

  it('defaults to the canonical tool-calling model', () => {
    const brain = createQvacBrain({ tools: [] });
    assert.match(brain.label, new RegExp(MODEL_CHOICES[DEFAULT_MODEL]));
  });

  it('rejects an unknown model name loudly (never a silent fallback)', () => {
    assert.throws(() => createQvacBrain({ model: 'gpt-9', tools: [] }), /unknown model "gpt-9"/);
  });
});

describe('brain-qvac: normalizeArgs (string vs object argument shapes)', () => {
  it('parses a JSON-encoded argument string', () => {
    assert.deepEqual(normalizeArgs('{"amount_usdt":"0.10","to":"@v"}'), { amount_usdt: '0.10', to: '@v' });
  });

  it('preserves a non-JSON string as a raw field instead of throwing', () => {
    assert.deepEqual(normalizeArgs('not-json'), { _raw: 'not-json' });
  });

  it('passes an object through and defaults nullish to an empty object', () => {
    assert.deepEqual(normalizeArgs({ a: 1 }), { a: 1 });
    assert.deepEqual(normalizeArgs(null), {});
    assert.deepEqual(normalizeArgs(undefined), {});
  });
});

describe('brain-qvac: normalizeArgKeys (alias mapping + confidence carry-over)', () => {
  it('maps the common argument-name aliases small models drift onto', () => {
    assert.equal(normalizeArgKeys({ creator: '@v' }, null).to, '@v');
    assert.equal(normalizeArgKeys({ handle: '@h' }, null).to, '@h');
    assert.equal(normalizeArgKeys({ seller: '@s' }, null).from, '@s');
    assert.equal(normalizeArgKeys({ amount: '0.10' }, null).amount_usdt, '0.10');
  });

  it('carries the deterministic score only when the model omitted its own', () => {
    assert.equal(normalizeArgKeys({}, { confidence: 88 }).confidence, 88);
    assert.equal(normalizeArgKeys({ confidence: 50 }, { confidence: 88 }).confidence, 50);
    assert.equal(normalizeArgKeys({ to: '@keep' }, null).to, '@keep', 'an existing key is never overwritten');
  });
});

describe('brain-qvac: think-tag helpers', () => {
  it('stripThinkMarkers removes think tags and trims', () => {
    assert.equal(stripThinkMarkers('  <think>reasoning</think>  '), 'reasoning');
  });

  it('extractAfterThink returns the post-</think> summary, or null when absent', () => {
    assert.equal(extractAfterThink(['thinking hard', '</think>', 'final call']), 'final call');
    assert.equal(extractAfterThink(['<think>weigh it</think> hold back']), 'weigh it hold back');
    assert.equal(extractAfterThink(['no think tag here at all']), null);
  });
});

describe('wdk-spark: pure sats / network / explorer helpers', () => {
  it('converts micros to sats at the disclosed 1 USD₮ = 1000 sat demo rate', () => {
    assert.equal(SATS_PER_USDT, 1000n);
    assert.equal(microsToSats(MICROS_PER_USDT), 1000n); // 1.00 USD₮
    assert.equal(microsToSats(50_000n), 50n); // 0.05 USD₮
  });

  it('names the network and builds explorer links per environment', () => {
    assert.equal(sparkNetworkName('TESTNET'), 'spark-testnet');
    assert.equal(explorerUrlFor('deadbeef', 'TESTNET'), 'https://www.sparkscan.io/tx/deadbeef?network=testnet');
    assert.equal(explorerUrlFor('deadbeef', 'MAINNET'), 'https://www.sparkscan.io/tx/deadbeef');
  });
});
