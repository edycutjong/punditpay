import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  NonceStore,
  X402Error,
  buildOffer,
  buildPaymentPayload,
  buildReceipt,
  canonicalPaymentBytes,
  decodePayment,
  decodeReceipt,
  encodePayment,
  parseOffer,
  verifyPayment,
} from '../src/core/x402.js';

const OFFER_INPUT = { resource: '/tip/@vantage', description: 'Tip for @vantage', payTo: 'jar-vantage', network: 'local-sim', amount: '0.15' };

function freshOffer(overrides = {}) {
  return { ...buildOffer(OFFER_INPUT).accepts[0], ...overrides };
}

function paymentFor(offer, overrides = {}) {
  return { ...buildPaymentPayload({ offer, from: 'pndt1abc', txHash: 'sim-123' }), signature: 'sig', ...overrides };
}

const acceptAll = async () => true;
const rejectAll = async () => false;

function rejectsWithCode(promise, code) {
  return assert.rejects(promise, (err) => {
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}: ${err.message}`);
    return true;
  });
}

describe('x402: offers', () => {
  it('buildOffer produces a spec-shaped 402 body', () => {
    const body = buildOffer(OFFER_INPUT);
    assert.equal(body.x402Version, 1);
    assert.equal(body.accepts.length, 1);
    const offer = body.accepts[0];
    assert.equal(offer.scheme, 'exact');
    assert.equal(offer.amount, '0.15');
    assert.ok(offer.nonce.length >= 32);
    assert.ok(Date.parse(offer.expiresAt) > Date.now());
  });

  it('every offer gets a unique nonce', () => {
    const nonces = new Set(Array.from({ length: 50 }, () => buildOffer(OFFER_INPUT).accepts[0].nonce));
    assert.equal(nonces.size, 50);
  });

  it('buildOffer validates the amount', () => {
    assert.throws(() => buildOffer({ ...OFFER_INPUT, amount: 'free' }));
  });

  it('buildOffer requires resource, payTo and network', () => {
    assert.throws(() => buildOffer({ ...OFFER_INPUT, payTo: undefined }), X402Error);
  });

  it('parseOffer round-trips buildOffer', () => {
    const body = buildOffer(OFFER_INPUT);
    assert.deepEqual(parseOffer(body), body.accepts[0]);
  });

  it('parseOffer rejects a non-x402 body', () => {
    assert.throws(() => parseOffer({ hello: 'world' }), X402Error);
  });

  it('parseOffer rejects unknown schemes only', () => {
    const body = buildOffer(OFFER_INPUT);
    body.accepts[0].scheme = 'streaming';
    assert.throws(() => parseOffer(body), /no-supported-scheme|no "exact"/);
  });

  it('parseOffer rejects an offer missing fields', () => {
    const body = buildOffer(OFFER_INPUT);
    delete body.accepts[0].nonce;
    assert.throws(() => parseOffer(body), X402Error);
  });
});

describe('x402: payment envelope', () => {
  it('encode/decode round-trips', () => {
    const payment = paymentFor(freshOffer());
    assert.deepEqual(decodePayment(encodePayment(payment)), payment);
  });

  it('decodePayment rejects a missing header', () => {
    assert.throws(() => decodePayment(undefined), /missing-payment|missing/);
  });

  it('decodePayment rejects non-base64 garbage', () => {
    assert.throws(() => decodePayment('%%%not-base64%%%'), X402Error);
  });

  it('decodePayment rejects an envelope missing the signature', () => {
    const { signature, ...rest } = paymentFor(freshOffer());
    assert.throws(() => decodePayment(encodePayment(rest)), X402Error);
  });

  it('decodePayment rejects null and empty required fields (audit B1)', () => {
    const base = paymentFor(freshOffer());
    assert.throws(() => decodePayment(encodePayment({ ...base, payTo: null })), (e) => e.code === 'malformed-payment');
    assert.throws(() => decodePayment(encodePayment({ ...base, from: '' })), (e) => e.code === 'malformed-payment');
    assert.throws(() => decodePayment(encodePayment({ ...base, network: null })), (e) => e.code === 'malformed-payment');
  });

  it('canonical bytes exclude the signature and sort keys', () => {
    const payment = paymentFor(freshOffer());
    const a = canonicalPaymentBytes(payment).toString();
    const b = canonicalPaymentBytes({ ...payment, signature: 'different' }).toString();
    assert.equal(a, b);
    assert.ok(!a.includes('signature'));
  });

  it('canonical bytes are key-order independent', () => {
    const payment = paymentFor(freshOffer());
    const shuffled = Object.fromEntries(Object.entries(payment).reverse());
    assert.equal(canonicalPaymentBytes(payment).toString(), canonicalPaymentBytes(shuffled).toString());
  });

  it('canonical bytes change when any field changes (tamper-evident)', () => {
    const payment = paymentFor(freshOffer());
    const tampered = { ...payment, amount: '9.99' };
    assert.notEqual(canonicalPaymentBytes(payment).toString(), canonicalPaymentBytes(tampered).toString());
  });
});

describe('x402: verifyPayment — every binding is checked', () => {
  it('accepts a matching payment with a passing verifier', async () => {
    const offer = freshOffer();
    assert.equal(await verifyPayment({ payment: paymentFor(offer), offer, verifier: acceptAll }), true);
  });

  it('rejects when the verifier fails the signature', async () => {
    const offer = freshOffer();
    await rejectsWithCode(verifyPayment({ payment: paymentFor(offer), offer, verifier: rejectAll }), 'bad-signature');
  });

  it('rejects a network mismatch', async () => {
    const offer = freshOffer();
    await rejectsWithCode(verifyPayment({ payment: paymentFor(offer, { network: 'spark-testnet' }), offer, verifier: acceptAll }), 'network-mismatch');
  });

  it('rejects an asset mismatch', async () => {
    const offer = freshOffer();
    await rejectsWithCode(verifyPayment({ payment: paymentFor(offer, { asset: 'BTC' }), offer, verifier: acceptAll }), 'asset-mismatch');
  });

  it('rejects a recipient mismatch (payment redirected)', async () => {
    const offer = freshOffer();
    await rejectsWithCode(verifyPayment({ payment: paymentFor(offer, { payTo: 'attacker' }), offer, verifier: acceptAll }), 'recipient-mismatch');
  });

  it('rejects a resource mismatch (receipt reused for another resource)', async () => {
    const offer = freshOffer();
    await rejectsWithCode(verifyPayment({ payment: paymentFor(offer, { resource: '/pick/other' }), offer, verifier: acceptAll }), 'resource-mismatch');
  });

  it('rejects a nonce mismatch', async () => {
    const offer = freshOffer();
    await rejectsWithCode(verifyPayment({ payment: paymentFor(offer, { nonce: 'stolen' }), offer, verifier: acceptAll }), 'nonce-mismatch');
  });

  it('rejects underpayment', async () => {
    const offer = freshOffer();
    await rejectsWithCode(verifyPayment({ payment: paymentFor(offer, { amount: '0.01' }), offer, verifier: acceptAll }), 'underpaid');
  });

  it('classifies a garbage amount as a protocol error, never a server error (audit B2)', async () => {
    const offer = freshOffer();
    await rejectsWithCode(verifyPayment({ payment: paymentFor(offer, { amount: 'lol' }), offer, verifier: acceptAll }), 'malformed-payment');
  });

  it('accepts overpayment (a generous tipper is welcome)', async () => {
    const offer = freshOffer();
    assert.equal(await verifyPayment({ payment: paymentFor(offer, { amount: '0.50' }), offer, verifier: acceptAll }), true);
  });

  it('rejects an expired offer', async () => {
    const offer = freshOffer();
    const past = Date.parse(offer.expiresAt) + 1;
    await rejectsWithCode(verifyPayment({ payment: paymentFor(offer), offer, verifier: acceptAll, now: past }), 'offer-expired');
  });

  it('rejects a wrong x402 version', async () => {
    const offer = freshOffer();
    await rejectsWithCode(verifyPayment({ payment: paymentFor(offer, { x402Version: 2 }), offer, verifier: acceptAll }), 'bad-version');
  });
});

describe('x402: receipts', () => {
  it('buildReceipt/decodeReceipt round-trip', () => {
    const payment = paymentFor(freshOffer());
    const receipt = decodeReceipt(buildReceipt({ payment, network: 'local-sim', explorerUrl: null }));
    assert.equal(receipt.success, true);
    assert.equal(receipt.txHash, 'sim-123');
    assert.equal(receipt.amount, '0.15');
  });

  it('decodeReceipt returns null on garbage instead of throwing', () => {
    assert.equal(decodeReceipt('garbage!!'), null);
    assert.equal(decodeReceipt(undefined), null);
  });
});

describe('x402: NonceStore — replay defense', () => {
  it('issues then consumes exactly once', () => {
    const store = new NonceStore();
    const offer = freshOffer();
    store.issue(offer);
    assert.deepEqual(store.consume(offer.nonce), offer);
  });

  it('a consumed nonce cannot be replayed', () => {
    const store = new NonceStore();
    const offer = freshOffer();
    store.issue(offer);
    store.consume(offer.nonce);
    assert.throws(() => store.consume(offer.nonce), (err) => err.code === 'replayed-nonce');
  });

  it('an unknown nonce is refused', () => {
    assert.throws(() => new NonceStore().consume('never-issued'), (err) => err.code === 'unknown-nonce');
  });

  it('an expired offer is refused and GCed', () => {
    let now = Date.now();
    const store = new NonceStore({ clock: () => now });
    const offer = freshOffer();
    store.issue(offer);
    now = Date.parse(offer.expiresAt) + 1;
    assert.throws(() => store.consume(offer.nonce), (err) => ['offer-expired', 'unknown-nonce'].includes(err.code));
    assert.equal(store.liveCount, 0);
  });

  it('gc drops only expired offers', () => {
    let now = Date.now();
    const store = new NonceStore({ clock: () => now });
    const shortLived = freshOffer({ expiresAt: new Date(now + 10).toISOString() });
    const longLived = freshOffer();
    store.issue(shortLived);
    store.issue(longLived);
    now += 1000;
    assert.equal(store.liveCount, 1);
  });

  it('spent-nonce memory is bounded: entries past TTL are GCed and still refuse replay as unknown (audit B3)', () => {
    let now = Date.now();
    const store = new NonceStore({ ttlMs: 1000, clock: () => now });
    const offer = freshOffer();
    store.issue(offer);
    store.consume(offer.nonce);
    assert.equal(store.spent.size, 1);
    now += 2000;
    store.gc();
    assert.equal(store.spent.size, 0);
    // The replay is STILL refused — just under a different code.
    assert.throws(() => store.consume(offer.nonce), (e) => e.code === 'unknown-nonce');
  });
});
