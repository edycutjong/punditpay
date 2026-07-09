#!/usr/bin/env node
/**
 * Reproducible benchmark — pick-formed → payment-settled, measured, not claimed.
 *
 *   1. decision latency      — evaluateMoment() over the scripted feed
 *   2. x402 round-trip       — real HTTP against a local tip jar (discover + settle + sign + receipt)
 *   3. full agent pipeline   — brain → policy gate → x402 payment, end to end
 *
 * Prints p50/p95/mean/min/max over N runs and writes bench-results.json.
 * With BENCH_QVAC=1 it also loads the on-device model and reports real
 * tokens/sec for one moment (needs the model downloaded; ~800 MB first run).
 */

import { writeFileSync } from 'node:fs';
import { ActionLedger } from '../src/core/ledger.js';
import { evaluateMoment } from '../src/core/decision.js';
import { loadMatchFeed } from '../src/core/matchfeed.js';
import { createTipJar, listen } from '../src/server/tipjar.js';
import { LOCAL_NETWORK, createLocalWallet, localVerifier } from '../src/wallet/devsigner.js';
import { payForResource } from '../src/agent/x402-client.js';
import { createRulesBrain } from '../src/agent/brain-rules.js';
import { createAgent, AGENT_TOOLS } from '../src/agent/agent.js';

const N_DECISION = Number(process.env.BENCH_DECISIONS ?? 10_000);
const N_X402 = Number(process.env.BENCH_PAYMENTS ?? 200);
const N_PIPELINE = Number(process.env.BENCH_PIPELINE ?? 100);

const RULE = { confidenceThreshold: 70, tipAmounts: { low: '0.05', medium: '0.10', high: '0.25' } };

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (q) => sorted[Math.min(Math.floor(q * sorted.length), sorted.length - 1)];
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    p50: round(pick(0.5)),
    p95: round(pick(0.95)),
    mean: round(sum / sorted.length),
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
  };
}
const round = (x) => Math.round(x * 1000) / 1000;

function printRow(name, s, unit) {
  console.log(
    `  ${name.padEnd(34)} n=${String(s.n).padEnd(6)} p50=${fmt(s.p50, unit)}  p95=${fmt(s.p95, unit)}  mean=${fmt(s.mean, unit)}  min=${fmt(s.min, unit)}  max=${fmt(s.max, unit)}`,
  );
}
const fmt = (v, unit) => `${v}${unit}`.padEnd(10);

const results = { generatedAt: new Date().toISOString(), host: `${process.platform}/${process.arch} node ${process.version}` };
console.log(`\nPunditPay bench — ${results.host}\n`);

// ── 1. decision latency (pure on-device reasoning path) ──
{
  const feed = loadMatchFeed().filter((m) => m.tippable);
  const samples = [];
  for (let i = 0; i < N_DECISION; i++) {
    const moment = feed[i % feed.length];
    const t0 = performance.now();
    evaluateMoment(moment, RULE);
    samples.push((performance.now() - t0) * 1000); // µs
  }
  results.decisionMicros = stats(samples);
  console.log('1 · decision latency (µs) — confidence scoring per match moment');
  printRow('evaluateMoment', results.decisionMicros, 'µs');
}

// ── 2. x402 round-trip over real HTTP ──
{
  const jar = createTipJar({ verifier: localVerifier(), network: LOCAL_NETWORK });
  const baseUrl = await listen(jar.server, 0);
  const wallet = createLocalWallet();
  const total = [];
  const discover = [];
  const settle = [];
  for (let i = 0; i < N_X402; i++) {
    const { timings } = await payForResource({ baseUrl, path: '/tip/@vantage?amount=0.05', wallet });
    total.push(timings.totalMs);
    discover.push(timings.discoverMs);
    settle.push(timings.settleMs);
  }
  jar.server.close();
  results.x402TotalMs = stats(total);
  results.x402DiscoverMs = stats(discover);
  results.x402SettleSignMs = stats(settle);
  console.log('\n2 · x402 payment round-trip (ms) — real HTTP, real ed25519, local settlement');
  printRow('discover (402 + offer)', results.x402DiscoverMs, 'ms');
  printRow('settle + sign + paid retry', results.x402SettleSignMs, 'ms');
  printRow('TOTAL pay-for-resource', results.x402TotalMs, 'ms');
}

// ── 3. full pipeline: moment → brain → policy → x402 → ledger ──
{
  const jar = createTipJar({ verifier: localVerifier(), network: LOCAL_NETWORK });
  const baseUrl = await listen(jar.server, 0);
  const heroMoment = loadMatchFeed().find((m) => m.expect === 'tip'); // 23' goal
  const samples = [];
  for (let i = 0; i < N_PIPELINE; i++) {
    const ledger = new ActionLedger();
    const agent = createAgent({
      feed: [],
      brain: createRulesBrain(),
      wallet: createLocalWallet(),
      ledger,
      tipjarUrl: baseUrl,
      paceMs: 0,
    });
    const t0 = performance.now();
    await agent.processMoment(heroMoment);
    samples.push(performance.now() - t0);
    if (ledger.ofKind('payment').length !== 1) throw new Error('bench pipeline failed to pay');
  }
  jar.server.close();
  results.pipelineMs = stats(samples);
  console.log('\n3 · full agent pipeline (ms) — pick formed → policy gate → payment settled');
  printRow('moment → settled tip', results.pipelineMs, 'ms');
}

// ── 4. optional: real on-device tokens/sec ──
if (process.env.BENCH_QVAC === '1') {
  console.log('\n4 · QVAC on-device inference (BENCH_QVAC=1)');
  const { createQvacBrain } = await import('../src/agent/brain-qvac.js');
  const brain = createQvacBrain({ tools: AGENT_TOOLS, onProgress: () => {} });
  await brain.ready();
  const moment = loadMatchFeed().find((m) => m.expect === 'tip-hero');
  const t0 = performance.now();
  await brain.evaluate(moment, { rule: RULE, capState: { spentMicros: 0n, capMicros: 1_000_000n, tipsLeft: 6 } });
  const elapsed = performance.now() - t0;
  const s = brain.stats();
  results.qvac = { elapsedMs: round(elapsed), tokensPerSecond: s?.tokensPerSecond ?? null, stats: s ?? null };
  console.log(`  one hero-moment completion: ${round(elapsed)}ms · ${s?.tokensPerSecond?.toFixed(1) ?? '?'} tok/s (on-device)`);
  await brain.dispose();
} else {
  console.log('\n4 · QVAC inference bench skipped — run BENCH_QVAC=1 npm run bench (downloads the model on first use)');
}

writeFileSync(new URL('../bench-results.json', import.meta.url), JSON.stringify(results, null, 2));
console.log('\n✔ wrote bench-results.json');
