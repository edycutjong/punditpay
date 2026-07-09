/**
 * x402 — payments over plain HTTP, the way HTTP 402 was always meant to work.
 *
 * Flow (one price-discovery round-trip, one paid round-trip):
 *
 *   client  GET /tip/@creator          →  402 + JSON offer {accepts:[…], nonce}
 *   client  settles + signs payload    →  GET /tip/@creator  [X-PAYMENT: base64]
 *   server  verifies sig + nonce + amount → 200 + resource   [X-PAYMENT-RESPONSE]
 *
 * This module is pure protocol logic (no sockets, no keys): offers, payment
 * envelopes, canonical signing bytes, verification rules, nonce lifecycle.
 * Settlement and signatures are supplied by wallet adapters (src/wallet/).
 */

import { randomBytes } from 'node:crypto';
import { parseUSDT } from './money.js';

export const X402_VERSION = 1;
export const PAYMENT_HEADER = 'x-payment';
export const RECEIPT_HEADER = 'x-payment-response';
export const DEFAULT_OFFER_TTL_MS = 120_000;

export class X402Error extends Error {
  /** @param {string} code machine-readable reason  @param {string} message human-readable detail */
  constructor(code, message) {
    super(message);
    this.name = 'X402Error';
    this.code = code;
  }
}

/** Server side: build the 402 response body advertising how to pay for a resource. */
export function buildOffer({ resource, description, payTo, network, asset = 'USDT', amount, nonce, ttlMs = DEFAULT_OFFER_TTL_MS, now = Date.now() }) {
  if (!resource || !payTo || !network) throw new X402Error('bad-offer', 'resource, payTo and network are required');
  parseUSDT(amount); // validates
  return {
    x402Version: X402_VERSION,
    error: 'payment required',
    accepts: [
      {
        scheme: 'exact',
        network,
        asset,
        amount,
        payTo,
        resource,
        description: description ?? resource,
        nonce: nonce ?? randomBytes(16).toString('hex'),
        expiresAt: new Date(now + ttlMs).toISOString(),
      },
    ],
  };
}

/** Client side: pick the first understandable offer out of a 402 body. */
export function parseOffer(body) {
  if (!body || body.x402Version !== X402_VERSION || !Array.isArray(body.accepts) || body.accepts.length === 0) {
    throw new X402Error('bad-offer', 'response is not a valid x402 payment-required body');
  }
  const offer = body.accepts.find((o) => o.scheme === 'exact');
  if (!offer) throw new X402Error('no-supported-scheme', 'no "exact" scheme offer found');
  for (const field of ['network', 'asset', 'amount', 'payTo', 'resource', 'nonce', 'expiresAt']) {
    if (!offer[field]) throw new X402Error('bad-offer', `offer is missing ${field}`);
  }
  parseUSDT(offer.amount);
  return offer;
}

/**
 * Canonical signing bytes for a payment payload: key-sorted JSON of everything
 * except the signature itself. Both sides derive the exact same bytes.
 */
export function canonicalPaymentBytes(payment) {
  const { signature, ...rest } = payment;
  const sorted = Object.fromEntries(Object.entries(rest).sort(([a], [b]) => (a < b ? -1 : 1)));
  return Buffer.from(JSON.stringify(sorted), 'utf8');
}

/** Client side: assemble the unsigned payment payload for an accepted offer. */
export function buildPaymentPayload({ offer, from, txHash, settledAt = new Date().toISOString() }) {
  return {
    x402Version: X402_VERSION,
    scheme: offer.scheme,
    network: offer.network,
    asset: offer.asset,
    amount: offer.amount,
    payTo: offer.payTo,
    resource: offer.resource,
    nonce: offer.nonce,
    from,
    txHash: txHash ?? null,
    settledAt,
  };
}

/** Encode a signed payment payload into the X-PAYMENT header value. */
export function encodePayment(payment) {
  return Buffer.from(JSON.stringify(payment), 'utf8').toString('base64');
}

/** Decode and shape-check an X-PAYMENT header. */
export function decodePayment(headerValue) {
  if (!headerValue) throw new X402Error('missing-payment', 'X-PAYMENT header is missing');
  let payment;
  try {
    payment = JSON.parse(Buffer.from(headerValue, 'base64').toString('utf8'));
  } catch {
    throw new X402Error('malformed-payment', 'X-PAYMENT header is not base64 JSON');
  }
  // Every required field must be present and non-empty. (txHash is the only
  // legitimately-nullable field and is deliberately not in this list.)
  for (const field of ['x402Version', 'scheme', 'network', 'asset', 'amount', 'payTo', 'resource', 'nonce', 'from', 'signature']) {
    if (payment[field] === undefined || payment[field] === null || payment[field] === '') {
      throw new X402Error('malformed-payment', `payment is missing ${field}`);
    }
  }
  return payment;
}

/**
 * Server side: check a decoded payment against the offer we issued.
 * Signature verification is the wallet adapter's job (verifier callback);
 * everything else — binding, amount, expiry, replay — is decided here.
 */
export async function verifyPayment({ payment, offer, verifier, now = Date.now() }) {
  if (payment.x402Version !== X402_VERSION) throw new X402Error('bad-version', `unsupported x402 version ${payment.x402Version}`);
  if (payment.scheme !== offer.scheme) throw new X402Error('scheme-mismatch', 'payment scheme does not match offer');
  if (payment.network !== offer.network) throw new X402Error('network-mismatch', 'payment network does not match offer');
  if (payment.asset !== offer.asset) throw new X402Error('asset-mismatch', 'payment asset does not match offer');
  if (payment.payTo !== offer.payTo) throw new X402Error('recipient-mismatch', 'payment recipient does not match offer');
  if (payment.resource !== offer.resource) throw new X402Error('resource-mismatch', 'payment resource does not match offer');
  if (payment.nonce !== offer.nonce) throw new X402Error('nonce-mismatch', 'payment nonce does not match offer');
  if (now > Date.parse(offer.expiresAt)) throw new X402Error('offer-expired', 'offer has expired');
  let paidMicros;
  try {
    paidMicros = parseUSDT(payment.amount);
  } catch {
    // A garbage amount is a protocol error (402), never a server error (500).
    throw new X402Error('malformed-payment', `payment amount is not a valid USDT string: ${JSON.stringify(payment.amount)}`);
  }
  if (paidMicros < parseUSDT(offer.amount)) {
    throw new X402Error('underpaid', `payment ${payment.amount} is below required ${offer.amount}`);
  }
  const ok = await verifier({ payment, bytes: canonicalPaymentBytes(payment) });
  if (!ok) throw new X402Error('bad-signature', 'payment signature verification failed');
  return true;
}

/** Build the X-PAYMENT-RESPONSE receipt header value. */
export function buildReceipt({ payment, network, explorerUrl = null }) {
  return Buffer.from(
    JSON.stringify({
      success: true,
      network,
      txHash: payment.txHash,
      amount: payment.amount,
      asset: payment.asset,
      payTo: payment.payTo,
      explorerUrl,
      settledAt: payment.settledAt,
    }),
    'utf8',
  ).toString('base64');
}

/** Decode an X-PAYMENT-RESPONSE receipt header. */
export function decodeReceipt(headerValue) {
  if (!headerValue) return null;
  try {
    return JSON.parse(Buffer.from(headerValue, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Single-use offer store with TTL — the server's defense against replay.
 * Issue an offer, then consume it exactly once when a payment arrives.
 */
export class NonceStore {
  constructor({ ttlMs = DEFAULT_OFFER_TTL_MS, clock = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.clock = clock;
    this.offers = new Map(); // nonce → { offer, expiresAtMs }
    this.spent = new Map(); // nonce → spentAtMs — GC'd after TTL (see note in consume)
  }

  issue(offer) {
    this.gc();
    this.offers.set(offer.nonce, { offer, expiresAtMs: Date.parse(offer.expiresAt) });
    return offer;
  }

  /** Look up and burn a nonce. Throws on unknown, expired, or replayed nonces. */
  consume(nonce) {
    this.gc();
    if (this.spent.has(nonce)) throw new X402Error('replayed-nonce', 'this payment nonce was already used');
    const entry = this.offers.get(nonce);
    if (!entry) throw new X402Error('unknown-nonce', 'no live offer for this nonce');
    if (this.clock() > entry.expiresAtMs) {
      this.offers.delete(nonce);
      throw new X402Error('offer-expired', 'offer has expired');
    }
    this.offers.delete(nonce);
    // Remembering a spent nonce past its offer TTL is redundant — a replay
    // after that fails as unknown-nonce anyway — so spent entries are GC'd
    // too and the store stays bounded on a long-running jar.
    this.spent.set(nonce, this.clock());
    return entry.offer;
  }

  gc() {
    const now = this.clock();
    for (const [nonce, entry] of this.offers) {
      if (now > entry.expiresAtMs) this.offers.delete(nonce);
    }
    for (const [nonce, spentAtMs] of this.spent) {
      if (now - spentAtMs > this.ttlMs) this.spent.delete(nonce);
    }
  }

  get liveCount() {
    this.gc();
    return this.offers.size;
  }
}
