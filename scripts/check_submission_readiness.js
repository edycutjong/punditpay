#!/usr/bin/env node
/**
 * Submission-readiness gate — refuses to let an unearned claim ship.
 *
 * HARD failures (exit 1): missing deliverables, placeholder text in the
 * repo docs, a README test-count that doesn't match `npm test` reality,
 * a wrong license.
 *
 * WARNINGS (exit 0, listed loudly): things only a human can finish —
 * the public repo URL, the demo video, a real Spark testnet tx hash.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';

const ROOT = new URL('..', import.meta.url).pathname;
const hard = [];
const warn = [];
const ok = [];

function requireFile(path, why) {
  if (existsSync(`${ROOT}${path}`)) ok.push(`${path} — ${why}`);
  else hard.push(`missing ${path} — ${why}`);
}

// ── 1. deliverables exist ──
requireFile('README.md', 'the judge’s front door');
requireFile('LICENSE', 'Apache-2.0 required by the rules');
requireFile('DEMO.md', 'exact demo steps');
requireFile('ARCHITECTURE.md', 'system diagram');
requireFile('SKILL.md', 'the reusable Agent Skill');
requireFile('landing/index.html', 'one-page explainer');
requireFile('console/index.html', 'the agent console');
requireFile('.env.example', 'documented env vars');
requireFile('scripts/bench.js', 'reproducible benchmark');
requireFile('scripts/verify_offline.js', 'offline-reasoning proof');
requireFile('.github/workflows/ci.yml', 'CI pipeline');
requireFile('punditpay_dorahacks_submission.md', 'submission copy');
requireFile('SPONSOR_DEFENSE.md', 'why ONLY QVAC + WDK (5+ methods each, cited)');
requireFile('COMPLEXITY.md', 'complexity blueprint (5 layers)');
requireFile('docs/SELF_REVIEW.md', 'hostile-judge self-review');
requireFile('docs/AUDIT_REPORT.md', 'self-audit + threat model');
// video-production drafts (VOICEOVER_PROMPT.md, YOUTUBE_METADATA.md) live in DemoStudio, not the repo

// ── 2. license really is Apache 2.0 ──
if (existsSync(`${ROOT}LICENSE`)) {
  const lic = readFileSync(`${ROOT}LICENSE`, 'utf8');
  if (/Apache License/.test(lic) && /Version 2\.0/.test(lic)) ok.push('LICENSE is Apache 2.0');
  else hard.push('LICENSE is not Apache 2.0 — the hackathon rules require it');
}
try {
  const pkg = JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8'));
  if (pkg.license === 'Apache-2.0') ok.push('package.json license is Apache-2.0');
  else hard.push(`package.json license is ${pkg.license}, expected Apache-2.0`);
} catch {
  hard.push('package.json unreadable');
}

// ── 3. placeholder scan in repo docs (submission form fields excluded — see below) ──
const PLACEHOLDER = /⬜|FILL_?ME|YOUR_?(KEY|URL|NAME)|lorem ipsum|TBD\b|COMING SOON/i;
for (const doc of ['README.md', 'DEMO.md', 'ARCHITECTURE.md', 'SKILL.md', 'SPONSOR_DEFENSE.md', 'COMPLEXITY.md']) {
  if (!existsSync(`${ROOT}${doc}`)) continue;
  const text = readFileSync(`${ROOT}${doc}`, 'utf8');
  const m = PLACEHOLDER.exec(text);
  if (m) hard.push(`${doc} contains placeholder "${m[0]}"`);
  else ok.push(`${doc} has no placeholders`);
}

// ── 4. README test-count claim must equal reality ──
if (existsSync(`${ROOT}README.md`)) {
  const readme = readFileSync(`${ROOT}README.md`, 'utf8');
  const claim = /\*\*(\d+)\s+tests?\*\*/.exec(readme) ?? /(\d+)\s+tests? \(node:test\)/.exec(readme);
  if (!claim) {
    hard.push('README does not state the exact test count');
  } else {
    let actual = null;
    try {
      const out = execFileSync('npm', ['test', '--silent'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      actual = Number(/^# pass (\d+)$/m.exec(out)?.[1] ?? NaN);
      const total = Number(/^# tests (\d+)$/m.exec(out)?.[1] ?? NaN);
      const fails = Number(/^# fail (\d+)$/m.exec(out)?.[1] ?? NaN);
      if (fails !== 0) hard.push(`test suite is RED (${fails} failing) — never submit red`);
      if (Number(claim[1]) === total && actual === total) ok.push(`README claims ${claim[1]} tests; npm test confirms ${actual}/${total} passing`);
      else hard.push(`README claims ${claim[1]} tests but npm test reports ${actual}/${total} passing — fix the claim or the suite`);
    } catch (err) {
      hard.push(`could not run npm test to verify the README claim: ${err.message.split('\n')[0]}`);
    }
  }
}

// ── 5. human-finishable items → warnings ──
if (existsSync(`${ROOT}README.md`)) {
  const readme = readFileSync(`${ROOT}README.md`, 'utf8');
  if (/youtu\.?be/.test(readme)) ok.push('README links a video');
  else warn.push('no YouTube link in README yet (≤3-min unlisted demo video required at submission)');
  if (/sparkscan\.io\/tx\//.test(readme)) ok.push('README embeds a Spark explorer tx link');
  else warn.push('no Spark testnet tx link in README yet — run the demo with --wallet=spark and paste one tx');
  if (/github\.com\/[\w-]+\/punditpay/i.test(readme)) ok.push('README references the public repo');
  else warn.push('public GitHub repo URL not in README yet');
}
{
  const sub = `${ROOT}punditpay_dorahacks_submission.md`;
  if (existsSync(sub)) {
    const text = readFileSync(sub, 'utf8');
    const fills = (text.match(/⬜ FILL/g) ?? []).length;
    if (fills > 0) warn.push(`submission draft has ${fills} human-only form fields marked ⬜ FILL (nation, teammates, video URL…)`);
  }
}

// ── report ──
console.log('\nPunditPay submission readiness\n');
for (const line of ok) console.log(`  ✔ ${line}`);
if (warn.length) {
  console.log('');
  for (const line of warn) console.log(`  ⚠ ${line}`);
}
if (hard.length) {
  console.log('');
  for (const line of hard) console.log(`  ✖ ${line}`);
  console.log(`\n✖ NOT ready: ${hard.length} hard failure${hard.length === 1 ? '' : 's'}, ${warn.length} warnings`);
  process.exit(1);
}
console.log(`\n✔ ready to submit pending ${warn.length} human step${warn.length === 1 ? '' : 's'} above (video · repo push · testnet tx)`);
