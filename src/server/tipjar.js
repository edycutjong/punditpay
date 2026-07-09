/**
 * The tip jar — an x402 resource server any creator could run.
 *
 * Two kinds of paid resources, one protocol:
 *   GET /tip/@handle[?amount=0.15]  → 402 offer → paid retry → 200 thank-you receipt
 *   GET /pick/<id>                  → 402 offer → paid retry → 200 the actual pick content
 * Plus two free ones:
 *   GET /health                     → liveness
 *   GET /jar                        → what the jar has received so far (per creator)
 *
 * No accounts, no API keys, no checkout — a payment IS the credential.
 * Built on node:http only; verification is pluggable (local ed25519 or Spark).
 */

import { createServer } from 'node:http';
import { CREATORS } from '../core/matchfeed.js';
import { formatUSDT, parseUSDT } from '../core/money.js';
import { NonceStore, PAYMENT_HEADER, RECEIPT_HEADER, X402Error, buildOffer, buildReceipt, decodePayment, verifyPayment } from '../core/x402.js';

/** The paid picks this jar sells. Content is real — the buyer gets an actual read. */
export const PICKS = Object.freeze({
  'half-time-read': {
    id: 'half-time-read',
    creator: '@tacticsroom',
    price: '0.25',
    title: 'How Astora wins this (half-time read)',
    content:
      'Meridia’s left side is pressing 8 yards too high. Astora should overload that flank after the hour: ' +
      'drag the fullback with a false winger, release the overlap late. Expect the winning chances to come ' +
      'from the left half-space between 55’ and 70’. If it goes late, watch for Meridia over-committing — ' +
      'a stoppage-time counter is live.',
  },
});

const MIN_TIP = '0.05';

/**
 * @param {{verifier: ({payment, bytes}) => Promise<boolean>, network: string,
 *          payToFor?: (handle: string) => string, explorerUrlFor?: (txHash: string) => string|null,
 *          settlementFor?: (amountMicros: bigint) => object|null, clock?: () => number}} opts
 */
export function createTipJar({ verifier, network, payToFor, explorerUrlFor, settlementFor, clock = Date.now }) {
  const nonces = new NonceStore({ clock });
  const received = []; // {kind, creator, amount, from, txHash, at}
  const resolvePayTo = payToFor ?? ((handle) => `jar-${handle.replace('@', '')}`);

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      if (url.pathname === '/health') return sendJson(res, 200, { ok: true, network, service: 'punditpay-tipjar' });
      if (url.pathname === '/jar') return sendJson(res, 200, jarStats());

      const tipMatch = /^\/tip\/(@[a-z0-9_]+)$/i.exec(url.pathname);
      const pickMatch = /^\/pick\/([a-z0-9-]+)$/i.exec(url.pathname);
      if (!tipMatch && !pickMatch) return sendJson(res, 404, { error: 'no such resource' });

      const paymentHeader = req.headers[PAYMENT_HEADER];

      if (tipMatch) {
        const creator = findCreator(tipMatch[1]);
        if (!creator) return sendJson(res, 404, { error: `unknown creator ${tipMatch[1]}` });
        const requested = url.searchParams.get('amount') ?? MIN_TIP;
        const amountMicros = safeParse(requested);
        if (amountMicros == null || amountMicros < parseUSDT(MIN_TIP)) {
          return sendJson(res, 400, { error: `tip amount must be a decimal USD₮ string ≥ ${MIN_TIP}` });
        }
        if (!paymentHeader) return send402(res, offerFor(url.pathname, `Tip for ${creator.handle} (${creator.role})`, creator.handle, requested, amountMicros));
        // `await` so a non-x402 fault from settlement is caught by handle()'s
        // try/catch and answered with a 500 — without it the rejection escapes
        // the handler and the socket hangs instead of responding.
        return await settleAndRespond(res, paymentHeader, {
          kind: 'tip',
          creator: creator.handle,
          respond: (payment) => ({
            thanks: `${creator.handle} says thank you! Every great call deserves a great tip.`,
            creator: creator.handle,
            amount: payment.amount,
            asset: payment.asset,
          }),
        });
      }

      const pick = PICKS[pickMatch[1]];
      if (!pick) return sendJson(res, 404, { error: `no such pick ${pickMatch[1]}` });
      if (!paymentHeader) return send402(res, offerFor(url.pathname, pick.title, pick.creator, pick.price, parseUSDT(pick.price)));
      return await settleAndRespond(res, paymentHeader, {
        kind: 'pick',
        creator: pick.creator,
        respond: () => ({ id: pick.id, title: pick.title, by: pick.creator, content: pick.content }),
      });
    } catch (err) {
      if (err instanceof X402Error) return sendJson(res, 402, { error: err.message, code: err.code });
      return sendJson(res, 500, { error: 'internal error' });
    }
  }

  function offerFor(resource, description, handle, amount, _amountMicros) {
    const offer = buildOffer({
      resource,
      description,
      payTo: resolvePayTo(handle),
      network,
      amount,
      now: clock(),
    });
    const settlement = settlementFor?.(_amountMicros);
    if (settlement) offer.accepts[0].settlement = settlement;
    nonces.issue(offer.accepts[0]);
    return offer;
  }

  async function settleAndRespond(res, paymentHeader, { kind, creator, respond }) {
    let payment;
    try {
      payment = decodePayment(paymentHeader);
    } catch (err) {
      return sendJson(res, 400, { error: err.message, code: err.code });
    }
    let offer;
    try {
      offer = nonces.consume(payment.nonce);
      await verifyPayment({ payment, offer, verifier, now: clock() });
    } catch (err) {
      if (err instanceof X402Error) return sendJson(res, 402, { error: err.message, code: err.code });
      throw err;
    }
    received.push({ kind, creator, amount: payment.amount, from: payment.from, txHash: payment.txHash, at: new Date(clock()).toISOString() });
    res.setHeader(RECEIPT_HEADER, buildReceipt({ payment, network, explorerUrl: explorerUrlFor?.(payment.txHash) ?? null }));
    return sendJson(res, 200, respond(payment));
  }

  function jarStats() {
    const perCreator = {};
    for (const entry of received) {
      const bucket = (perCreator[entry.creator] ??= { tips: 0, picksSold: 0, totalMicros: 0n });
      bucket[entry.kind === 'tip' ? 'tips' : 'picksSold'] += 1;
      bucket.totalMicros += parseUSDT(entry.amount);
    }
    return {
      network,
      received: received.length,
      creators: Object.fromEntries(
        Object.entries(perCreator).map(([handle, b]) => [handle, { tips: b.tips, picksSold: b.picksSold, total: formatUSDT(b.totalMicros) }]),
      ),
      entries: received,
    };
  }

  const server = createServer(handle);
  return { server, handle, received, nonces };
}

function findCreator(handle) {
  return Object.values(CREATORS).find((c) => c.handle.toLowerCase() === handle.toLowerCase()) ?? null;
}

function safeParse(text) {
  try {
    return parseUSDT(text);
  } catch {
    return null;
  }
}

function send402(res, offerBody) {
  return sendJson(res, 402, offerBody);
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

/** Start listening; resolves with the bound base URL (port 0 friendly for tests). */
export function listen(server, port = 0, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve(`http://${host}:${addr.port}`);
    });
  });
}
