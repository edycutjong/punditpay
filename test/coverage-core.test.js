/**
 * Targeted branch/edge coverage for the pure core + client modules — the
 * defensive paths the happy-path and e2e suites don't reach. Every test here
 * drives REAL code (no SDK mocks): a controllable clock, a deliberately-faulty
 * verifier, a scripted fetch dispatcher, and honest malformed inputs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  NonceStore,
  PAYMENT_HEADER,
  RECEIPT_HEADER,
  buildOffer,
  buildPaymentPayload,
  canonicalPaymentBytes,
  decodeReceipt,
  encodePayment,
  parseOffer,
} from '../src/core/x402.js';
import { createTipJar, listen } from '../src/server/tipjar.js';
import { LOCAL_NETWORK, createLocalWallet, localVerifier } from '../src/wallet/devsigner.js';
import { payForResource } from '../src/agent/x402-client.js';
import { createAgent } from '../src/agent/agent.js';
import { ActionLedger } from '../src/core/ledger.js';
import { createRulesBrain } from '../src/agent/brain-rules.js';
import { scoreMoment, evaluateMoment } from '../src/core/decision.js';

// ── x402 NonceStore: the offer that expires BETWEEN gc() and the freshness
// check inside consume() (a clock that advances mid-call) ──────────────────
describe('x402 NonceStore: consume() catches an offer that expires under it', () => {
  it('deletes and rejects an offer whose clock crossed expiry mid-consume', () => {
    // The clock returns "not yet expired" for issue()+consume()'s gc scan, then
    // "expired" for consume()'s own freshness check → the 201-203 branch.
    let n = 0;
    const clock = () => (n++ < 2 ? 500 : 1500);
    const store = new NonceStore({ clock });
    store.issue({ nonce: 'race', expiresAt: new Date(1000).toISOString() });
    assert.throws(() => store.consume('race'), (err) => err.code === 'offer-expired');
    assert.equal(store.offers.has('race'), false, 'the expired offer is dropped from the store');
  });
});

// ── agent: a non-policy error from enforce() must propagate, not be swallowed ─
describe('agent executeToolCall: a non-PolicyViolationError propagates', () => {
  function agentUnderTest(paceMs = 0, feed = []) {
    const ledger = new ActionLedger();
    const agent = createAgent({
      feed,
      brain: createRulesBrain(),
      wallet: createLocalWallet(),
      ledger,
      tipjarUrl: 'http://127.0.0.1:1',
      paceMs,
    });
    return { agent, ledger };
  }

  it('rethrows an unexpected error thrown by the policy engine', async () => {
    const { agent } = agentUnderTest();
    // A genuine fault in the guardrail (not a policy denial) must surface, never
    // be misread as "allowed".
    agent.policy.enforce = async () => {
      throw new Error('guardrail-engine-fault');
    };
    const toolCall = { name: 'pay_tip', arguments: { amount_usdt: '0.05', to: '@vantage', reason: 'a genuine sentence', confidence: 90 } };
    await assert.rejects(agent.executeToolCall(toolCall, { seq: 1, minute: 10 }), /guardrail-engine-fault/);
  });

  it('paces the session between moments when paceMs > 0', async () => {
    // One non-tippable moment: runSession loops once and hits the sleep() delay.
    const feed = [{ seq: 1, minute: 1, type: 'kickoff', creator: null, tippable: false, significance: 'low', headline: 'ko', text: 'kickoff' }];
    const { agent } = agentUnderTest(1, feed);
    const summary = await agent.runSession();
    assert.equal(summary.tips, 0);
    assert.equal(summary.payments, 0);
  });
});

// ── devsigner: the balance/dispose surface + the two verifier catch paths ────
describe('devsigner: local wallet balance, dispose, and verifier guards', () => {
  async function signedPayment(wallet, overrides = {}) {
    const offer = buildOffer({ resource: '/tip/@vantage', payTo: 'jar-v', network: LOCAL_NETWORK, amount: '0.10' }).accepts[0];
    const settlement = await wallet.settle(offer);
    const unsigned = { ...buildPaymentPayload({ offer, from: settlement.from, txHash: settlement.txHash }), fromPublicKey: wallet.publicKeyB64() };
    const signature = await wallet.signBytes(canonicalPaymentBytes(unsigned));
    return { ...unsigned, signature, ...overrides };
  }

  it('getBalance reports an honest simulated balance', async () => {
    const balance = await createLocalWallet().getBalance();
    assert.equal(balance.simulated, true);
    assert.match(balance.note, /local-sim/);
  });

  it('dispose is a safe no-op', () => {
    assert.equal(createLocalWallet().dispose(), undefined);
  });

  it('a non-string public key fails the verifier without throwing', async () => {
    const verify = localVerifier();
    // Truthy but not a string → Buffer.from(..., "base64") throws → caught → false.
    assert.equal(await verify({ payment: { fromPublicKey: 123, signature: 'sig', from: 'pndt1abc' }, bytes: Buffer.from('x') }), false);
  });

  it('a non-string signature fails the verifier without throwing', async () => {
    const verify = localVerifier();
    const wallet = createLocalWallet();
    // Valid key + address, but the signature is a number → Buffer.from throws in
    // the verify step → the catch returns false rather than crashing the server.
    const payment = { ...(await signedPayment(wallet)), signature: 123 };
    assert.equal(await verify({ payment, bytes: canonicalPaymentBytes(payment) }), false);
  });
});

// ── x402 client: the price-discovery branches + rejected-payment handling ────
describe('x402 client: discovery + settlement failure paths', () => {
  const response = (status, body, ok) => ({ status, ok: ok ?? (status >= 200 && status < 300), json: async () => body });
  const wallet = () => createLocalWallet();

  it('a free 200 resource is returned with no payment path', async () => {
    const fetchImpl = async () => response(200, { free: true });
    const out = await payForResource({ baseUrl: 'http://jar', path: '/free', wallet: wallet(), fetchImpl });
    assert.deepEqual(out.resource, { free: true });
    assert.equal(out.payment, null);
    assert.equal(out.offer, null);
  });

  it('a non-402, non-ok status is an unexpected-status error', async () => {
    const fetchImpl = async () => response(500, {}, false);
    await assert.rejects(
      payForResource({ baseUrl: 'http://jar', path: '/oops', wallet: wallet(), fetchImpl }),
      (err) => err.code === 'unexpected-status',
    );
  });

  it('a rejected paid retry surfaces the server code and reason', async () => {
    const offer = buildOffer({ resource: '/tip/@v', payTo: 'jar', network: LOCAL_NETWORK, amount: '0.05' });
    const fetchImpl = async (_url, opts) => (opts ? response(402, { code: 'server-said-no', error: 'nope' }) : response(402, offer));
    await assert.rejects(
      payForResource({ baseUrl: 'http://jar', path: '/tip/@v?amount=0.05', wallet: wallet(), fetchImpl }),
      (err) => err.code === 'server-said-no' && /nope/.test(err.message),
    );
  });

  it('a rejected paid retry with an unreadable body still throws cleanly', async () => {
    const offer = buildOffer({ resource: '/tip/@v', payTo: 'jar', network: LOCAL_NETWORK, amount: '0.05' });
    const fetchImpl = async (_url, opts) =>
      opts
        ? { status: 503, ok: false, json: async () => { throw new Error('body is not json'); } }
        : response(402, offer);
    await assert.rejects(
      payForResource({ baseUrl: 'http://jar', path: '/tip/@v?amount=0.05', wallet: wallet(), fetchImpl }),
      (err) => err.code === 'payment-rejected' && /unknown reason/.test(err.message),
    );
  });
});

// ── tip jar: an internal (non-x402) fault is a 500, never a crash ────────────
describe('tip jar: an unexpected verifier fault becomes a 500', () => {
  it('returns 500 when the verifier throws a non-x402 error', async () => {
    const jar = createTipJar({ verifier: async () => { throw new Error('verifier exploded'); }, network: LOCAL_NETWORK });
    const base = await listen(jar.server, 0);
    try {
      const wallet = createLocalWallet();
      const offer = parseOffer(await (await fetch(`${base}/tip/@vantage?amount=0.05`)).json());
      const settlement = await wallet.settle(offer);
      const unsigned = { ...buildPaymentPayload({ offer, from: settlement.from, txHash: settlement.txHash }), fromPublicKey: wallet.publicKeyB64() };
      const payment = { ...unsigned, signature: await wallet.signBytes(canonicalPaymentBytes(unsigned)) };
      const paid = await fetch(`${base}/tip/@vantage?amount=0.05`, { headers: { [PAYMENT_HEADER]: encodePayment(payment) } });
      assert.equal(paid.status, 500);
      assert.equal((await paid.json()).error, 'internal error');
    } finally {
      jar.server.close();
    }
  });
});

// ── tip jar: the spark-mode config hooks (payTo / settlement / explorer) ─────
describe('tip jar: honours the settlement + explorer config a spark jar supplies', () => {
  it('uses payToFor, embeds settlement metadata in the offer, and links the explorer in the receipt', async () => {
    const jar = createTipJar({
      verifier: localVerifier(),
      network: 'spark-testnet',
      payToFor: (handle) => `spark1${handle.replace('@', '')}`,
      settlementFor: (micros) => ({ unit: 'sat', value: String(micros / 1000n) }),
      explorerUrlFor: (txHash) => `https://www.sparkscan.io/tx/${txHash}?network=testnet`,
    });
    const base = await listen(jar.server, 0);
    try {
      const wallet = createLocalWallet();
      const offer = parseOffer(await (await fetch(`${base}/tip/@vantage?amount=0.05`)).json());
      assert.equal(offer.payTo, 'spark1vantage', 'the configured payTo is used');
      assert.ok(offer.settlement, 'settlement metadata is attached to the offer');
      assert.equal(offer.settlement.unit, 'sat');

      const settlement = await wallet.settle(offer);
      const unsigned = { ...buildPaymentPayload({ offer, from: settlement.from, txHash: settlement.txHash }), fromPublicKey: wallet.publicKeyB64() };
      const payment = { ...unsigned, signature: await wallet.signBytes(canonicalPaymentBytes(unsigned)) };
      const paid = await fetch(`${base}/tip/@vantage?amount=0.05`, { headers: { [PAYMENT_HEADER]: encodePayment(payment) } });
      assert.equal(paid.status, 200);
      const receipt = decodeReceipt(paid.headers.get(RECEIPT_HEADER));
      assert.match(receipt.explorerUrl, /sparkscan\.io/, 'the receipt carries the explorer link');
    } finally {
      jar.server.close();
    }
  });
});

// ── decision engine: nullish-defaulting, the 99 cap, and every reason branch ─
describe('decision: nullish defaults, confidence cap, and reason branches', () => {
  it('scoreMoment defaults missing signals and caps confidence at 99', () => {
    const bare = scoreMoment({ tippable: true }); // unknown significance → 0, no hit-rate → 0
    assert.equal(bare.confidence, 20);
    const called = scoreMoment({ significance: 'high', calledIt: true, creatorHitRate: 1 }); // missing minute/callMinute → 0 lead
    assert.ok(called.confidence <= 99);
    const maxed = scoreMoment({ significance: 'high', calledIt: true, callMinute: 0, minute: 100, creatorHitRate: 1 });
    assert.equal(maxed.confidence, 99, 'confidence is clamped to 99');
  });

  it('evaluateMoment picks amount by suggestedTip → table → default, and every reason branch', () => {
    const clears = { tippable: true, significance: 'high', calledIt: true, callMinute: 0, minute: 10, creatorHitRate: 1, headline: 'h' };
    assert.equal(evaluateMoment({ ...clears, suggestedTip: '0.20' }, { confidenceThreshold: 10, tipAmounts: {} }).amount, '0.20');
    assert.equal(evaluateMoment({ ...clears, significance: 'medium' }, { confidenceThreshold: 10, tipAmounts: { medium: '0.10' } }).amount, '0.10');
    assert.equal(evaluateMoment(clears, { confidenceThreshold: 10, tipAmounts: {} }).amount, '0.10', 'falls back to the 0.10 default');

    const notTippable = evaluateMoment({ tippable: false, headline: 'h' }, { confidenceThreshold: 10, tipAmounts: {} });
    assert.equal(notTippable.shouldTip, false);
    assert.match(notTippable.reason, /not a tippable moment/);

    const below = evaluateMoment({ tippable: true, significance: 'low', headline: 'h' }, { confidenceThreshold: 90, tipAmounts: {} });
    assert.equal(below.shouldTip, false);
    assert.match(below.reason, /holding back/);
  });
});
