/**
 * E2E: the x402 tip jar over REAL HTTP — real sockets, real 402s, real
 * signatures. No mocks anywhere in this file.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTipJar, listen } from '../src/server/tipjar.js';
import { LOCAL_NETWORK, createLocalWallet, localVerifier } from '../src/wallet/devsigner.js';
import { payForResource } from '../src/agent/x402-client.js';
import { PAYMENT_HEADER, RECEIPT_HEADER, buildPaymentPayload, canonicalPaymentBytes, decodeReceipt, encodePayment, parseOffer } from '../src/core/x402.js';

let jar;
let baseUrl;
let wallet;

before(async () => {
  jar = createTipJar({ verifier: localVerifier(), network: LOCAL_NETWORK });
  baseUrl = await listen(jar.server, 0);
  wallet = createLocalWallet();
});

after(() => {
  jar.server.close();
});

describe('tip jar: plumbing', () => {
  it('GET /health is free and honest about its network', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.network, 'local-sim');
  });

  it('unknown resources 404', async () => {
    assert.equal((await fetch(`${baseUrl}/nope`)).status, 404);
  });

  it('unknown creators 404', async () => {
    assert.equal((await fetch(`${baseUrl}/tip/@nobody`)).status, 404);
  });

  it('non-GET methods are refused', async () => {
    assert.equal((await fetch(`${baseUrl}/tip/@vantage`, { method: 'POST' })).status, 405);
  });

  it('a bad amount is a 400 with an explanation', async () => {
    const res = await fetch(`${baseUrl}/tip/@vantage?amount=free`);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /decimal USD₮/);
  });
});

describe('tip jar: the 402 offer', () => {
  it('an unpaid tip request returns a parseable x402 offer', async () => {
    const res = await fetch(`${baseUrl}/tip/@vantage?amount=0.15`);
    assert.equal(res.status, 402);
    const offer = parseOffer(await res.json());
    assert.equal(offer.amount, '0.15');
    assert.equal(offer.network, 'local-sim');
    assert.equal(offer.resource, '/tip/@vantage');
  });

  it('an unpaid pick request quotes the pick price', async () => {
    const res = await fetch(`${baseUrl}/pick/half-time-read`);
    assert.equal(res.status, 402);
    const offer = parseOffer(await res.json());
    assert.equal(offer.amount, '0.25');
  });
});

describe('tip jar: paying (the whole point)', () => {
  it('x402 client completes discover → settle → sign → resource in one paid round-trip', async () => {
    const { resource, receipt, timings } = await payForResource({ baseUrl, path: '/tip/@vantage?amount=0.15', wallet });
    assert.match(resource.thanks, /@vantage says thank you/);
    assert.equal(receipt.success, true);
    assert.equal(receipt.amount, '0.15');
    assert.match(receipt.txHash, /^sim-/);
    assert.ok(timings.totalMs > 0);
  });

  it('a paid pick returns the ACTUAL content', async () => {
    const { resource } = await payForResource({ baseUrl, path: '/pick/half-time-read', wallet });
    assert.equal(resource.by, '@tacticsroom');
    assert.match(resource.content, /stoppage-time counter is live/);
  });

  it('the receipt header decodes to a structured receipt', async () => {
    const res = await fetch(`${baseUrl}/tip/@vantage?amount=0.05`);
    const offer = parseOffer(await res.json());
    const settlement = await wallet.settle(offer);
    const unsigned = { ...buildPaymentPayload({ offer, from: settlement.from, txHash: settlement.txHash }), fromPublicKey: wallet.publicKeyB64() };
    const payment = { ...unsigned, signature: await wallet.signBytes(canonicalPaymentBytes(unsigned)) };
    const paid = await fetch(`${baseUrl}/tip/@vantage?amount=0.05`, { headers: { [PAYMENT_HEADER]: encodePayment(payment) } });
    assert.equal(paid.status, 200);
    const receipt = decodeReceipt(paid.headers.get(RECEIPT_HEADER));
    assert.equal(receipt.success, true);
    assert.equal(receipt.payTo, offer.payTo);
  });

  it('the jar records what it received, per creator', async () => {
    const res = await fetch(`${baseUrl}/jar`);
    const stats = await res.json();
    assert.ok(stats.received >= 3);
    assert.ok(stats.creators['@vantage'].tips >= 2);
    assert.ok(stats.creators['@tacticsroom'].picksSold >= 1);
  });
});

describe('tip jar: attacks it refuses', () => {
  async function freshSignedPayment(path, mutate = (p) => p) {
    const res = await fetch(`${baseUrl}${path}`);
    const offer = parseOffer(await res.json());
    const settlement = await wallet.settle(offer);
    const unsigned = { ...buildPaymentPayload({ offer, from: settlement.from, txHash: settlement.txHash }), fromPublicKey: wallet.publicKeyB64() };
    const payment = mutate({ ...unsigned, signature: await wallet.signBytes(canonicalPaymentBytes(unsigned)) });
    return { offer, payment };
  }

  it('replaying a spent nonce is refused', async () => {
    const { payment } = await freshSignedPayment('/tip/@vantage?amount=0.05');
    const first = await fetch(`${baseUrl}/tip/@vantage?amount=0.05`, { headers: { [PAYMENT_HEADER]: encodePayment(payment) } });
    assert.equal(first.status, 200);
    const replay = await fetch(`${baseUrl}/tip/@vantage?amount=0.05`, { headers: { [PAYMENT_HEADER]: encodePayment(payment) } });
    assert.equal(replay.status, 402);
    assert.equal((await replay.json()).code, 'replayed-nonce');
  });

  it('a tampered amount breaks the signature and is refused', async () => {
    const { payment } = await freshSignedPayment('/tip/@vantage?amount=0.05', (p) => ({ ...p, amount: '0.06' }));
    const res = await fetch(`${baseUrl}/tip/@vantage?amount=0.05`, { headers: { [PAYMENT_HEADER]: encodePayment(payment) } });
    assert.equal(res.status, 402);
    assert.equal((await res.json()).code, 'bad-signature');
  });

  it('an underpaid-but-honestly-signed payment is refused', async () => {
    // Sign a fresh payload that claims LESS than the offer demands.
    const res = await fetch(`${baseUrl}/tip/@vantage?amount=0.25`);
    const offer = parseOffer(await res.json());
    const settlement = await wallet.settle(offer);
    const unsigned = {
      ...buildPaymentPayload({ offer, from: settlement.from, txHash: settlement.txHash }),
      amount: '0.05',
      fromPublicKey: wallet.publicKeyB64(),
    };
    const payment = { ...unsigned, signature: await wallet.signBytes(canonicalPaymentBytes(unsigned)) };
    const paid = await fetch(`${baseUrl}/tip/@vantage?amount=0.25`, { headers: { [PAYMENT_HEADER]: encodePayment(payment) } });
    assert.equal(paid.status, 402);
    assert.equal((await paid.json()).code, 'underpaid');
  });

  it('a made-up nonce is refused', async () => {
    const { payment } = await freshSignedPayment('/tip/@vantage?amount=0.05', (p) => ({ ...p, nonce: 'invented' }));
    const res = await fetch(`${baseUrl}/tip/@vantage?amount=0.05`, { headers: { [PAYMENT_HEADER]: encodePayment(payment) } });
    assert.equal(res.status, 402);
    assert.match((await res.json()).code, /unknown-nonce/);
  });

  it('a garbage X-PAYMENT header is a 400, not a crash', async () => {
    const res = await fetch(`${baseUrl}/tip/@vantage?amount=0.05`, { headers: { [PAYMENT_HEADER]: '###' } });
    assert.equal(res.status, 400);
  });

  it('a signed payment with a garbage amount is a 402 protocol error, never a 500 (audit B2)', async () => {
    const { payment } = await freshSignedPayment('/tip/@vantage?amount=0.05', (p) => ({ ...p, amount: 'all of it' }));
    const res = await fetch(`${baseUrl}/tip/@vantage?amount=0.05`, { headers: { [PAYMENT_HEADER]: encodePayment(payment) } });
    assert.equal(res.status, 402);
    assert.equal((await res.json()).code, 'malformed-payment');
  });

  it("an impostor signing with their own key for someone else's address is refused", async () => {
    const impostor = createLocalWallet();
    const { payment } = await freshSignedPayment('/tip/@vantage?amount=0.05');
    const forged = { ...payment, fromPublicKey: impostor.publicKeyB64() };
    const res = await fetch(`${baseUrl}/tip/@vantage?amount=0.05`, { headers: { [PAYMENT_HEADER]: encodePayment(forged) } });
    assert.equal(res.status, 402);
    assert.equal((await res.json()).code, 'bad-signature');
  });

  it('the same signed payment fired 10x concurrently settles EXACTLY once — no double-spend race (audit B10)', async () => {
    // The nonce is burned synchronously in consume() before the async verify,
    // so even a burst of identical requests can only settle one.
    const res = await fetch(`${baseUrl}/tip/@banterfc?amount=0.05`);
    const offer = parseOffer(await res.json());
    const settlement = await wallet.settle(offer);
    const unsigned = { ...buildPaymentPayload({ offer, from: settlement.from, txHash: settlement.txHash }), fromPublicKey: wallet.publicKeyB64() };
    const header = encodePayment({ ...unsigned, signature: await wallet.signBytes(canonicalPaymentBytes(unsigned)) });

    const jarBefore = (await (await fetch(`${baseUrl}/jar`)).json()).received;
    const statuses = await Promise.all(
      Array.from({ length: 10 }, () => fetch(`${baseUrl}/tip/@banterfc?amount=0.05`, { headers: { [PAYMENT_HEADER]: header } }).then((r) => r.status)),
    );
    assert.equal(statuses.filter((s) => s === 200).length, 1, 'exactly one 200');
    assert.equal(statuses.filter((s) => s === 402).length, 9, 'nine refused');
    const jarAfter = (await (await fetch(`${baseUrl}/jar`)).json()).received;
    assert.equal(jarAfter - jarBefore, 1, 'the jar was paid exactly once');
  });
});
