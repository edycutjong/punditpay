/**
 * x402 client — how the agent pays for anything over plain HTTP.
 *
 *   1. request the resource            → HTTP 402 + offer
 *   2. settle with the wallet, sign    → retry with X-PAYMENT header
 *   3. receive the resource + receipt  → done. No account, no API key.
 *
 * `fetchImpl` is injectable: tests pass a loopback dispatcher, verify_offline
 * passes a tripwire that throws on ANY network attempt.
 */

import {
  PAYMENT_HEADER,
  RECEIPT_HEADER,
  X402Error,
  buildPaymentPayload,
  canonicalPaymentBytes,
  decodeReceipt,
  encodePayment,
  parseOffer,
} from '../core/x402.js';
import { parseUSDT } from '../core/money.js';

/**
 * @param {{baseUrl: string, path: string, wallet: object, fetchImpl?: typeof fetch,
 *          maxAmountMicros?: bigint|null}} opts
 *   `maxAmountMicros` is the spending authorization the caller's policy already
 *   approved. An offer demanding MORE than that is refused before settlement —
 *   the wallet must never sign an amount the policy never saw.
 * @returns {Promise<{resource: object, receipt: object|null, offer: object, payment: object,
 *                    settlement: object, timings: {discoverMs: number, settleMs: number, totalMs: number}}>}
 */
export async function payForResource({ baseUrl, path, wallet, fetchImpl = fetch, maxAmountMicros = null }) {
  const url = new URL(path, baseUrl).toString();
  const t0 = performance.now();

  // 1 — price discovery: ask for the resource, expect 402.
  const discovery = await fetchImpl(url);
  if (discovery.status !== 402) {
    if (discovery.ok) {
      // Free resource — no payment path needed.
      return { resource: await discovery.json(), receipt: null, offer: null, payment: null, settlement: null, timings: timings(t0, t0) };
    }
    throw new X402Error('unexpected-status', `expected 402 from ${url}, got ${discovery.status}`);
  }
  const offer = parseOffer(await discovery.json());
  if (maxAmountMicros != null && parseUSDT(offer.amount) > maxAmountMicros) {
    throw new X402Error(
      'offer-exceeds-authorization',
      `offer demands ${offer.amount} USDT but only ${formatMicros(maxAmountMicros)} was authorized by policy`,
    );
  }
  const t1 = performance.now();

  // 2 — settle + sign. The wallet adapter decides what settlement means
  // (Spark transfer on-chain, or an honest local-sim fingerprint).
  const settlement = await wallet.settle(offer);
  const unsigned = buildPaymentPayload({ offer, from: settlement.from, txHash: settlement.txHash });
  const pubkey = wallet.publicKeyB64?.();
  if (pubkey) unsigned.fromPublicKey = pubkey;
  const signature = await wallet.signBytes(canonicalPaymentBytes(unsigned));
  const payment = { ...unsigned, signature };

  // 3 — present payment, receive the resource.
  const paid = await fetchImpl(url, { headers: { [PAYMENT_HEADER]: encodePayment(payment) } });
  if (paid.status !== 200) {
    const body = await safeJson(paid);
    throw new X402Error(body?.code ?? 'payment-rejected', `payment rejected (${paid.status}): ${body?.error ?? 'unknown reason'}`);
  }
  const resource = await paid.json();
  const receipt = decodeReceipt(paid.headers.get(RECEIPT_HEADER));
  return { resource, receipt, offer, payment, settlement, timings: timings(t0, t1) };
}

function timings(t0, t1) {
  const now = performance.now();
  return {
    discoverMs: round2(t1 - t0),
    settleMs: round2(now - t1),
    totalMs: round2(now - t0),
  };
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function formatMicros(micros) {
  const whole = micros / 1_000_000n;
  const frac = (micros % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}.00`;
}
