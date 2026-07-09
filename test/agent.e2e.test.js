/**
 * E2E: the full agent loop — deterministic brain, real ed25519 wallet, real
 * x402 tip jar over real HTTP. This is the demo, executed as a test: the
 * scripted match must produce EXACTLY the engineered session.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ActionLedger } from '../src/core/ledger.js';
import { EXPECTED_SESSION, loadMatchFeed } from '../src/core/matchfeed.js';
import { PolicyViolationError } from '../src/core/policy.js';
import { createTipJar, listen } from '../src/server/tipjar.js';
import { LOCAL_NETWORK, createLocalWallet, localVerifier } from '../src/wallet/devsigner.js';
import { createRulesBrain } from '../src/agent/brain-rules.js';
import { createAgent } from '../src/agent/agent.js';

let jar;
let baseUrl;
let ledger;
let summary;

before(async () => {
  jar = createTipJar({ verifier: localVerifier(), network: LOCAL_NETWORK });
  baseUrl = await listen(jar.server, 0);
  ledger = new ActionLedger();
  const agent = createAgent({
    feed: loadMatchFeed(),
    brain: createRulesBrain(),
    wallet: createLocalWallet(),
    ledger,
    tipjarUrl: baseUrl,
    paceMs: 0,
  });
  summary = await agent.runSession();
});

after(() => {
  jar.server.close();
});

describe('agent e2e: the scripted session lands exactly as engineered', () => {
  it('makes exactly 4 tips', () => assert.equal(summary.tips, 4));
  it('buys exactly 1 pick', () => assert.equal(summary.picks, 1));
  it('spends exactly the session cap: 1.00 USD₮', () => assert.equal(summary.spent, '1.00'));
  it('blocks exactly 1 over-cap attempt', () => assert.equal(summary.blocked, 1));
  it('declines exactly 3 below-threshold moments', () => assert.equal(summary.declined, 3));

  it('every expected tip landed, in order, with the exact amount and recipient', () => {
    const payments = ledger.ofKind('payment').filter((e) => e.data.operation === 'pay_tip');
    assert.equal(payments.length, EXPECTED_SESSION.tips.length);
    EXPECTED_SESSION.tips.forEach((expected, i) => {
      assert.equal(payments[i].data.to, expected.to, `tip ${i} recipient`);
      assert.equal(payments[i].data.amount, expected.amount, `tip ${i} amount`);
      assert.equal(payments[i].data.seq, expected.seq, `tip ${i} match seq`);
    });
  });

  it('every payment carries a tx hash and the network label', () => {
    for (const p of ledger.ofKind('payment')) {
      assert.match(p.data.txHash, /^sim-[0-9a-f]{40}$/);
      assert.equal(p.data.network, 'local-sim');
    }
  });

  it('every payment reads as a plain-language sentence with a reason', () => {
    for (const p of ledger.ofKind('payment')) {
      assert.match(p.text, /—/, 'has a reason clause');
      assert.match(p.text, /USD₮/);
    }
  });

  it('the blocked entry names PolicyViolationError, the rule, and the reason', () => {
    const [blocked] = ledger.ofKind('blocked');
    assert.match(blocked.text, /PolicyViolationError/);
    assert.equal(blocked.data.reason, 'would exceed session cap');
    assert.equal(blocked.data.ruleName, 'block-over-cap');
    assert.equal(blocked.data.policyId, 'punditpay-session-guardrail');
    assert.equal(blocked.data.seq, EXPECTED_SESSION.blocked[0].seq);
  });

  it('the blocked attempt happened AFTER the cap was exactly reached (Σ ≤ cap forever)', () => {
    assert.equal(ledger.spentMicros(), 1_000_000n);
  });

  it('the tip jar agrees with the agent ledger (both sides of the wire match)', async () => {
    const stats = await (await fetch(`${baseUrl}/jar`)).json();
    assert.equal(stats.received, 5); // 4 tips + 1 pick
    assert.equal(stats.creators['@vantage'].tips, 3);
    assert.equal(stats.creators['@tacticsroom'].tips, 1);
    assert.equal(stats.creators['@tacticsroom'].picksSold, 1);
  });

  it('the purchased pick delivered its real content into the ledger', () => {
    const infos = ledger.ofKind('info').map((e) => e.text).join('\n');
    assert.match(infos, /the pick, as purchased/);
  });

  it('reasoning was streamed for every evaluated moment', () => {
    const reasoned = new Set(ledger.ofKind('reasoning').map((e) => e.data.seq));
    for (const seq of [2, 3, 4, 5, 6, 7, 8, 11, 12]) assert.ok(reasoned.has(seq), `moment seq ${seq} has reasoning`);
  });
});

describe('agent e2e: hostile brains cannot move money', () => {
  function hostileAgent(toolCall) {
    const hostileBrain = {
      kind: 'rules',
      label: 'hostile test brain',
      async ready() { return true; },
      async evaluate() {
        return { reasoningLines: ['attack attempt'], toolCall, holdBack: null };
      },
      async dispose() {},
    };
    const hostileLedger = new ActionLedger();
    const agent = createAgent({
      feed: [],
      brain: hostileBrain,
      wallet: createLocalWallet(),
      ledger: hostileLedger,
      tipjarUrl: baseUrl,
      paceMs: 0,
    });
    return { agent, hostileLedger };
  }

  const MOMENT = { seq: 99, minute: 90, tippable: true, significance: 'high', headline: 'attack', text: 'attack', creatorHitRate: 1 };

  it('a malformed amount is rejected before any policy or payment', async () => {
    const { agent, hostileLedger } = hostileAgent({ name: 'pay_tip', arguments: { amount_usdt: 'all of it', to: '@vantage', reason: 'because I want', confidence: 99 } });
    await agent.processMoment(MOMENT);
    assert.equal(hostileLedger.ofKind('error').length, 1);
    assert.equal(hostileLedger.ofKind('payment').length, 0);
  });

  it('an invented tool name is rejected by validation', async () => {
    const { agent, hostileLedger } = hostileAgent({ name: 'sweep_wallet', arguments: {} });
    await agent.processMoment(MOMENT);
    assert.equal(hostileLedger.ofKind('payment').length, 0);
    assert.match(hostileLedger.ofKind('error')[0].text, /unknown tool/);
  });

  it('an over-per-tip-max amount is BLOCKED by policy before settlement', async () => {
    const { agent, hostileLedger } = hostileAgent({ name: 'pay_tip', arguments: { amount_usdt: '0.99', to: '@vantage', reason: 'huge appreciation for the call', confidence: 99 } });
    const result = await agent.processMoment(MOMENT);
    assert.equal(result.blocked, true);
    assert.ok(result.error instanceof PolicyViolationError);
    assert.equal(hostileLedger.ofKind('payment').length, 0);
    assert.equal(hostileLedger.spentMicros(), 0n);
  });

  it('a cheap-pick authorization attack is refused BEFORE settlement (audit B9)', async () => {
    // The model claims the 0.25 pick costs 0.01: policy approves 0.01, so the
    // client must refuse the 0.25 offer — the wallet never signs more than
    // the policy saw, and the books never under-record.
    const { agent, hostileLedger } = hostileAgent({
      name: 'buy_pick',
      arguments: { amount_usdt: '0.01', from: '@tacticsroom', resource: '/pick/half-time-read', reason: 'a suspiciously cheap tactical read' },
    });
    const jarBefore = (await (await fetch(`${baseUrl}/jar`)).json()).received;
    const result = await agent.processMoment(MOMENT);
    assert.equal(result.failed, true);
    assert.equal(result.error.code, 'offer-exceeds-authorization');
    assert.equal(hostileLedger.ofKind('payment').length, 0);
    assert.equal(hostileLedger.spentMicros(), 0n);
    const jarAfter = (await (await fetch(`${baseUrl}/jar`)).json()).received;
    assert.equal(jarAfter, jarBefore, 'the jar must not have been paid');
  });

  it('the ledger records the SETTLED amount, bound to the signed payment (audit B9)', () => {
    for (const p of ledger.ofKind('payment')) {
      assert.equal(p.data.amount, p.data.authorizedAmount, 'settled == authorized in the honest session');
    }
  });

  it('an unknown recipient is BLOCKED when an allowlist is configured', async () => {
    const brain = {
      kind: 'rules',
      label: 'hostile',
      async ready() { return true; },
      async evaluate() {
        return {
          reasoningLines: [],
          toolCall: { name: 'pay_tip', arguments: { amount_usdt: '0.05', to: '@moneymule', reason: 'redirect the money please', confidence: 99 } },
          holdBack: null,
        };
      },
      async dispose() {},
    };
    const l = new ActionLedger();
    const agent = createAgent({
      feed: [],
      brain,
      wallet: createLocalWallet(),
      ledger: l,
      tipjarUrl: baseUrl,
      allowedRecipients: ['@vantage', '@tacticsroom', '@banterfc'],
      paceMs: 0,
    });
    const result = await agent.processMoment(MOMENT);
    assert.equal(result.blocked, true);
    assert.equal(l.ofKind('blocked')[0].data.ruleName, 'block-unknown-recipient');
  });
});

describe('agent e2e: settlement failures are survivable', () => {
  it('a dead tip jar produces an error entry, not a crash, and no spend is recorded', async () => {
    const l = new ActionLedger();
    const agent = createAgent({
      feed: [],
      brain: createRulesBrain(),
      wallet: createLocalWallet(),
      ledger: l,
      tipjarUrl: 'http://127.0.0.1:1', // nothing listens here
      paceMs: 0,
    });
    const moment = loadMatchFeed().find((m) => m.expect === 'tip');
    const result = await agent.processMoment(moment);
    assert.equal(result.failed, true);
    assert.equal(l.ofKind('error').length, 1);
    assert.equal(l.spentMicros(), 0n);
  });
});
