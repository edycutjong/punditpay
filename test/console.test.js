/**
 * The agent console server (src/server/console.js).
 *
 * The request routes are driven over REAL sockets (no mock http), the live SSE
 * fan-out is exercised by attaching a capture sink to the server's exposed
 * client set, and consoleState()/bigintSafe are asserted directly — including
 * the bigint-serialisation branch that a naive JSON.stringify would crash on.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createConsoleServer, consoleState } from '../src/server/console.js';
import { listen } from '../src/server/tipjar.js';
import { ActionLedger } from '../src/core/ledger.js';
import { createAgent } from '../src/agent/agent.js';
import { createRulesBrain } from '../src/agent/brain-rules.js';
import { createLocalWallet } from '../src/wallet/devsigner.js';

function fixture({ sessionCap } = {}) {
  const ledger = new ActionLedger();
  const brain = createRulesBrain();
  const wallet = createLocalWallet();
  const agent = createAgent({
    feed: [],
    brain,
    wallet,
    ledger,
    tipjarUrl: 'http://127.0.0.1:1',
    limits: sessionCap ? { sessionCap, maxTip: '0.25', maxTips: 6, maxPick: '0.25', maxPicks: 1 } : undefined,
    paceMs: 0,
  });
  return { ledger, brain, wallet, agent, getState: () => consoleState({ ledger, agent, brain, wallet }) };
}

describe('console: consoleState + bigintSafe', () => {
  it('projects the live cap/brain/wallet state the UI renders from', () => {
    const { ledger, getState } = fixture();
    ledger.append('payment', 'Tipped 0.25 USD₮ to @vantage', { operation: 'pay_tip', amountMicros: 250_000n });
    const state = getState();
    assert.equal(state.brain.kind, 'rules');
    assert.equal(state.wallet.network, 'local-sim');
    assert.equal(state.spent, '0.25');
    assert.equal(state.cap, '1.00');
    assert.equal(state.spentPct, 25);
    assert.equal(state.tipsLeft, 5);
  });

  it('guards against a zero session cap (no divide-by-zero in spentPct)', () => {
    const { getState } = fixture({ sessionCap: '0' });
    const state = getState();
    assert.equal(state.cap, '0.00');
    assert.equal(state.spentPct, 0);
  });
});

describe('console: SSE fan-out to connected clients', () => {
  it('broadcasts an entry frame and a state frame, serialising bigints as strings', () => {
    const { ledger, getState } = fixture();
    const { clients } = createConsoleServer({ ledger, getState });
    const captured = [];
    // A response-stream capture sink stands in for a connected browser's SSE
    // socket — this exercises the real fan-out + bigint serialisation, not a
    // faked SDK.
    const sink = { write: (chunk) => captured.push(chunk) };
    clients.add(sink);
    ledger.append('payment', 'Tipped 0.25 USD₮ to @vantage', { operation: 'pay_tip', amountMicros: 250_000n });
    clients.delete(sink);

    assert.equal(captured.length, 2, 'one entry frame + one state frame');
    assert.match(captured[0], /^event: entry\ndata: /);
    assert.match(captured[0], /"amountMicros":"250000"/, 'the bigint was serialised as a string, not crashed on');
    assert.match(captured[1], /^event: state\ndata: /);
  });
});

describe('console: HTTP routes over real sockets', () => {
  let server;
  let clients;
  let base;
  let ledger;

  before(async () => {
    const fx = fixture();
    ledger = fx.ledger;
    ledger.append('payment', 'Tipped 0.15 USD₮ to @vantage', { operation: 'pay_tip', amountMicros: 150_000n });
    ({ server, clients } = createConsoleServer({ ledger, getState: fx.getState }));
    base = await listen(server, 0);
  });

  after(() => server.close());

  it('GET / serves the self-contained console HTML', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /<html|<!doctype|<meta/i);
  });

  it('GET /state returns the JSON state snapshot', async () => {
    const res = await fetch(`${base}/state`);
    assert.equal(res.status, 200);
    const state = await res.json();
    assert.equal(state.spent, '0.15');
  });

  it('an unknown route is a 404 JSON error', async () => {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /not found/);
  });

  it('GET /events streams history + state, registers, then unregisters on close', async () => {
    const ac = new AbortController();
    const res = await fetch(`${base}/events`, { signal: ac.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const { value } = await res.body.getReader().read();
    const text = Buffer.from(value).toString('utf8');
    assert.match(text, /event: entry/, 'replayed the ledger history');
    assert.match(text, /event: state/, 'sent the initial state');
    assert.ok(clients.size >= 1, 'the SSE client is registered');

    ac.abort();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(clients.size, 0, 'the client is dropped when the connection closes');
  });
});
