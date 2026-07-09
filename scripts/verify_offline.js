#!/usr/bin/env node
/**
 * Offline verification — proves the core claim:
 *
 *   "The decision to pay is computed locally; removing network access still
 *    lets the agent reason and decide — it just can't settle."
 *
 * Method: a tripwire replaces fetch AND raw socket connects so ANY network
 * attempt throws (and is recorded). Then:
 *
 *   phase 1 — the agent reasons over the ENTIRE scripted match and reaches
 *             every decision. Required: zero network attempts.
 *   phase 2 — a settlement is attempted with the network dead. Required:
 *             it fails cleanly (error entry, no spend recorded, no crash).
 *
 * Exit 0 only if both phases hold.
 */

import net from 'node:net';
import process from 'node:process';
import { ActionLedger } from '../src/core/ledger.js';
import { evaluateMoment } from '../src/core/decision.js';
import { loadMatchFeed } from '../src/core/matchfeed.js';
import { createRulesBrain } from '../src/agent/brain-rules.js';
import { createAgent } from '../src/agent/agent.js';

// ── the tripwire ──
const attempts = [];
globalThis.fetch = async (input) => {
  attempts.push(String(input));
  throw new Error(`OFFLINE: fetch blocked (${input})`);
};
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  attempts.push(`socket:${JSON.stringify(args[0])}`);
  this.destroy(new Error('OFFLINE: socket blocked'));
  return this;
};

const RULE = { confidenceThreshold: 70, tipAmounts: { low: '0.05', medium: '0.10', high: '0.25' } };
let failed = false;

console.log('\nPunditPay offline verification — network is now dead by construction\n');

// ── phase 1: full-match reasoning with zero network ──
{
  const feed = loadMatchFeed();
  const brain = createRulesBrain();
  await brain.ready();
  let decisions = 0;
  for (const moment of feed) {
    if (!moment.tippable && !moment.pickOffer) continue;
    const result = await brain.evaluate(moment, { rule: RULE, capState: { spentMicros: 0n, capMicros: 1_000_000n, tipsLeft: 6 } });
    const deterministic = evaluateMoment(moment, RULE);
    if (!result.reasoningLines.length) failed = true;
    decisions += 1;
    const verdict = result.toolCall ? `→ ${result.toolCall.name}(${result.toolCall.arguments.amount_usdt})` : '→ hold back';
    console.log(`  ✓ minute ${String(moment.minute).padStart(2)}' reasoned offline · confidence ${deterministic.confidence}% ${verdict}`);
  }
  if (attempts.length > 0) {
    console.error(`\n✖ PHASE 1 FAILED — reasoning touched the network: ${attempts.join(', ')}`);
    failed = true;
  } else {
    console.log(`\n✔ phase 1: ${decisions} decisions reached with ZERO network attempts`);
  }
}

// ── phase 2: settlement honestly fails offline ──
{
  const ledger = new ActionLedger();
  const { createLocalWallet } = await import('../src/wallet/devsigner.js');
  const agent = createAgent({
    feed: [],
    brain: createRulesBrain(),
    wallet: createLocalWallet(),
    ledger,
    tipjarUrl: 'http://127.0.0.1:4021',
    paceMs: 0,
  });
  const moment = loadMatchFeed().find((m) => m.expect === 'tip');
  const result = await agent.processMoment(moment);
  const errorEntries = ledger.ofKind('error');
  if (result?.failed && errorEntries.length === 1 && ledger.spentMicros() === 0n) {
    console.log('✔ phase 2: settlement failed cleanly offline — error logged, zero spend recorded, no crash');
    console.log(`  ledger says: "${errorEntries[0].text}"`);
  } else {
    console.error('✖ PHASE 2 FAILED — offline settlement did not degrade cleanly');
    failed = true;
  }
  if (attempts.length === 0) {
    console.error('✖ PHASE 2 sanity check failed — settlement never even tried the network?');
    failed = true;
  }
}

net.Socket.prototype.connect = originalConnect;

if (failed) {
  console.error('\n✖ offline verification FAILED');
  process.exit(1);
}
console.log('\n✔ offline verification PASSED — reasoning is local; only settlement needs a wire.');
console.log('  (with --brain=qvac the model file itself is local too: load once, then airplane-mode works the same)');
