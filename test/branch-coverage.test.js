/**
 * Branch-completion suite — the remaining defensive/nullish/default/mismatch
 * branches the happy-path + e2e suites don't take. Every one is reached by a
 * DIRECT call with the edge input (no mocks): a payment with no txHash, a
 * scheme mismatch, an unknown-significance moment, a free-resource settlement,
 * a mis-configured tip jar, a default-deny enforce, a reason-less DENY rule,
 * and the malformed buy_pick validations.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  X402Error,
  buildOffer,
  buildPaymentPayload,
  parseOffer,
  verifyPayment,
} from '../src/core/x402.js';
import { scoreMoment } from '../src/core/decision.js';
import { payForResource } from '../src/agent/x402-client.js';
import { ActionLedger, describePayment } from '../src/core/ledger.js';
import { createAgent } from '../src/agent/agent.js';
import { createRulesBrain } from '../src/agent/brain-rules.js';
import { createTipJar, listen } from '../src/server/tipjar.js';
import { createLocalWallet, localVerifier } from '../src/wallet/devsigner.js';
import { PolicyConfigurationError, PolicyEngine, PolicyViolationError, buildTipPolicy } from '../src/core/policy.js';
import { validateToolCall, buildMomentPrompt } from '../src/core/prompts.js';
import { parseUSDT } from '../src/core/money.js';

// ── x402.js ──────────────────────────────────────────────────────────────────
describe('x402: nullish txHash + scheme-mismatch branches', () => {
  it('buildPaymentPayload defaults a missing txHash to null', () => {
    const offer = buildOffer({ resource: '/tip/@v', payTo: 'jar', network: 'local-sim', amount: '0.10' }).accepts[0];
    assert.equal(buildPaymentPayload({ offer, from: 'pndt1abc' }).txHash, null);
  });

  it('verifyPayment rejects a scheme mismatch', async () => {
    const offer = buildOffer({ resource: '/tip/@v', payTo: 'jar', network: 'local-sim', amount: '0.10' }).accepts[0];
    const payment = { ...buildPaymentPayload({ offer, from: 'pndt1abc', txHash: 'sim-1' }), scheme: 'streaming', signature: 'sig' };
    await assert.rejects(verifyPayment({ payment, offer, verifier: async () => true }), (err) => err.code === 'scheme-mismatch');
  });
});

// ── decision.js ──────────────────────────────────────────────────────────────
describe('decision: an unknown significance defaults its weight to 0', () => {
  it('scoreMoment treats an out-of-vocabulary significance as 0 points', () => {
    const s = scoreMoment({ significance: 'cataclysmic', tippable: true });
    // base 20 only — the unknown significance contributes nothing (the ?? 0 path).
    assert.equal(s.confidence, 20);
    assert.equal(s.factors.find((f) => f.name === 'significance').points, 0);
  });
});

// ── x402-client.js ───────────────────────────────────────────────────────────
describe('x402 client: formatMicros renders a whole-number authorization', () => {
  it('an offer above a whole-USD₮ authorization is refused with a ".00" figure', async () => {
    const offer = buildOffer({ resource: '/pick/x', payTo: 'jar', network: 'local-sim', amount: '2.00' });
    const fetchImpl = async () => ({ status: 402, ok: false, json: async () => offer });
    await assert.rejects(
      payForResource({ baseUrl: 'http://jar', path: '/pick/x', wallet: createLocalWallet(), fetchImpl, maxAmountMicros: 1_000_000n }),
      (err) => err.code === 'offer-exceeds-authorization' && /1\.00 was authorized/.test(err.message),
    );
  });
});

// ── ledger.js ────────────────────────────────────────────────────────────────
describe('ledger: missing-amount accounting + a txless payment sentence', () => {
  it('spentMicros treats a payment with no amountMicros as zero', () => {
    const ledger = new ActionLedger();
    ledger.append('payment', 'a payment with no micros recorded', { operation: 'pay_tip' });
    assert.equal(ledger.spentMicros(), 0n);
  });

  it('describePayment omits the tx clause for a tip with no hash', () => {
    const line = describePayment({ operation: 'pay_tip', amount: '0.05', to: '@vantage', reason: 'nice read', txHash: null });
    assert.match(line, /Tipped 0\.05 USD₮ to @vantage — nice read/);
    assert.doesNotMatch(line, /· tx /);
  });
});

// ── agent.js ─────────────────────────────────────────────────────────────────
describe('agent: hold-back fallback + a resource that settles free', () => {
  function agentWith({ fetchImpl } = {}) {
    const ledger = new ActionLedger();
    const agent = createAgent({
      feed: [],
      brain: createRulesBrain(),
      wallet: createLocalWallet(),
      ledger,
      tipjarUrl: 'http://127.0.0.1:1',
      fetchImpl,
      paceMs: 0,
    });
    return { agent, ledger };
  }

  it('logs a generic hold-back when the brain declines without a sentence', async () => {
    const ledger = new ActionLedger();
    const brain = {
      kind: 'rules',
      label: 'silent-decline brain',
      async ready() { return true; },
      async evaluate() { return { reasoningLines: [], toolCall: null, holdBack: null }; },
      async dispose() {},
    };
    const agent = createAgent({ feed: [], brain, wallet: createLocalWallet(), ledger, tipjarUrl: 'http://127.0.0.1:1', paceMs: 0 });
    await agent.processMoment({ seq: 1, minute: 10, tippable: true, significance: 'low', headline: 'h', text: 't' });
    assert.equal(ledger.ofKind('decision')[0].text, 'held back');
  });

  it('records a payment even when the resource comes back free (no on-chain settlement)', async () => {
    // A 200 with no 402 means the resource was free: payForResource returns a
    // null payment/settlement, so the ledger falls back to the authorized
    // amount and the wallet's own network label.
    const { agent, ledger } = agentWith({ fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ free: true }) }) });
    const result = await agent.executeToolCall(
      { name: 'pay_tip', arguments: { amount_usdt: '0.05', to: '@vantage', reason: 'a genuine appreciation', confidence: 90 } },
      { seq: 1, minute: 10 },
    );
    assert.equal(result.paid, true);
    const [payment] = ledger.ofKind('payment');
    assert.equal(payment.data.amount, '0.05');
    assert.equal(payment.data.txHash, null);
    assert.equal(payment.data.network, 'local-sim'); // fell back to wallet.network
  });
});

// ── tipjar.js ────────────────────────────────────────────────────────────────
describe('tip jar: default amount, unknown pick, mis-config, and bigint settlement', () => {
  async function withJar(opts, fn) {
    const jar = createTipJar({ verifier: localVerifier(), ...opts });
    const base = await listen(jar.server, 0);
    try {
      return await fn(base, jar);
    } finally {
      jar.server.close();
    }
  }

  it('a tip request with no amount falls back to the minimum tip', async () => {
    await withJar({ network: 'local-sim' }, async (base) => {
      const res = await fetch(`${base}/tip/@vantage`);
      assert.equal(res.status, 402);
      assert.equal(parseOffer(await res.json()).amount, '0.05');
    });
  });

  it('a well-formed but unknown pick id is a 404', async () => {
    await withJar({ network: 'local-sim' }, async (base) => {
      const res = await fetch(`${base}/pick/no-such-pick`);
      assert.equal(res.status, 404);
      assert.match((await res.json()).error, /no such pick/);
    });
  });

  it('an X402Error raised inside the handler surfaces as a 402 (mis-configured jar)', async () => {
    // A jar built with an empty network makes buildOffer throw inside handle()'s
    // try — the catch must answer 402, not crash. This exercises the X402 arm of
    // that catch (the honest-error path).
    await withJar({ network: '' }, async (base) => {
      const res = await fetch(`${base}/tip/@vantage?amount=0.05`);
      assert.equal(res.status, 402);
      assert.equal((await res.json()).code, 'bad-offer');
    });
  });

  it('serialises a bigint settlement value in the offer body without crashing', async () => {
    await withJar({ network: 'local-sim', settlementFor: (micros) => ({ unit: 'sat', value: micros / 1000n }) }, async (base) => {
      const res = await fetch(`${base}/tip/@vantage?amount=0.05`);
      assert.equal(res.status, 402);
      const offer = parseOffer(await res.json());
      assert.equal(offer.settlement.value, '50'); // 50_000 micros / 1000 → 50n → "50"
    });
  });
});

// ── policy.js ────────────────────────────────────────────────────────────────
describe('policy: default-deny error shape, rule validation, reasonless DENY, pick defaults', () => {
  const ALLOW_SMALL = { id: 'p1', rules: [{ name: 'allow-small', operation: 'pay_tip', action: 'ALLOW', conditions: [] }] };

  it('enforce on an unaddressed operation throws a default-deny PolicyViolationError (null ids)', async () => {
    const engine = new PolicyEngine().registerPolicy(ALLOW_SMALL);
    await assert.rejects(engine.enforce('mystery_op', { amountMicros: 1n }), (err) => {
      assert.ok(err instanceof PolicyViolationError);
      assert.equal(err.policyId, null);
      assert.equal(err.ruleName, null);
      assert.equal(err.reason, 'no-applicable-rule');
      assert.match(err.message, /\(default-deny\)/);
      return true;
    });
  });

  it('registration rejects a rule with no name and a rule with no operation', () => {
    assert.throws(
      () => new PolicyEngine().registerPolicy({ id: 'x', rules: [{ operation: 'op', action: 'ALLOW', conditions: [] }] }),
      PolicyConfigurationError,
    );
    assert.throws(
      () => new PolicyEngine().registerPolicy({ id: 'y', rules: [{ name: 'r', action: 'ALLOW', conditions: [] }] }),
      PolicyConfigurationError,
    );
  });

  it('a matched DENY rule with no explicit reason gets a generated one', async () => {
    const engine = new PolicyEngine().registerPolicy({
      id: 'z',
      rules: [{ name: 'deny-unnamed', operation: 'pay_tip', action: 'DENY', conditions: [] }],
    });
    const r = await engine.simulate('pay_tip', {});
    assert.equal(r.decision, 'DENY');
    assert.equal(r.reason, 'denied by rule deny-unnamed');
  });

  it('buildTipPolicy defaults the pick budget/allowance to zero when omitted', async () => {
    const policy = buildTipPolicy(
      { sessionCapMicros: parseUSDT('1.00'), maxTipMicros: parseUSDT('0.25'), maxTips: 6 },
      { spentMicros: () => 0n, tipCount: () => 0, pickCount: () => 0 },
    );
    const engine = new PolicyEngine().registerPolicy(policy);
    // With no pick budget configured, any pick purchase is denied.
    assert.equal((await engine.simulate('buy_pick', { amountMicros: parseUSDT('0.25') })).decision, 'DENY');
  });
});

// ── prompts.js ───────────────────────────────────────────────────────────────
describe('prompts: malformed buy_pick validation + the suggested-tip prompt branch', () => {
  it('rejects every malformed buy_pick field', () => {
    const base = { name: 'buy_pick', arguments: { amount_usdt: '0.25', from: '@t', resource: '/pick/x', reason: 'a genuine sentence here' } };
    assert.equal(validateToolCall({ ...base, arguments: { ...base.arguments, amount_usdt: 'nope' } }).ok, false); // amount
    assert.equal(validateToolCall({ ...base, arguments: { ...base.arguments, from: 'noatsign' } }).ok, false); // from: string, no @
    assert.equal(validateToolCall({ ...base, arguments: { ...base.arguments, from: 123 } }).ok, false); // from: not a string
    assert.equal(validateToolCall({ ...base, arguments: { ...base.arguments, reason: 'tiny' } }).ok, false); // reason too short
  });

  it('buildMomentPrompt emits the explicit pay_tip instruction when a tip is suggested', () => {
    const p = buildMomentPrompt(
      { minute: 23, text: 'GOAL', creator: '@vantage', creatorHitRate: 0.78, significance: 'high', suggestedTip: '0.15' },
      { confidence: 88, factors: [{ name: 'base', points: 20 }] },
    );
    assert.match(p, /CALL pay_tip NOW with amount_usdt="0\.15"/);
    assert.match(p, /to="@vantage"/);
  });
});
