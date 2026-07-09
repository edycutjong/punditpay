#!/usr/bin/env node
/**
 * Project linter — syntax + the two invariants that define this project:
 *
 *   1. FRAMING GUARD — PunditPay is tipping / pay-per-pick, never gambling.
 *      Betting vocabulary in src/ is a lint FAILURE, not a style nit.
 *   2. ZERO-CLOUD GUARD — all reasoning is on-device. Any cloud-AI host
 *      appearing in src/ fails the build.
 *
 * Plus: `node --check` on every JS file, and no TODO/FIXME left in src/.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const ROOT = new URL('..', import.meta.url).pathname;
const failures = [];

function walk(dir, ext = '.js') {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, ext));
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}

const jsFiles = ['src', 'bin', 'scripts', 'test'].flatMap((d) => walk(join(ROOT, d)));

// ── 1. syntax ──
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failures.push(`syntax: ${file}\n${err.stderr}`);
  }
}

// ── 2. framing guard (src + bin + console + landing) ──
// \b(bet|bets)\b would catch legitimate words like "better", so anchor carefully.
const FORBIDDEN_FRAMING = /\b(wager(s|ing|ed)?|gambl(e|es|ing|ed)|bookmaker|sportsbook|betting|odds-on|stake against)\b/i;
// The linter must name the words it bans — exempt itself from its own scan.
const framingFiles = [...jsFiles.filter((f) => !f.endsWith('scripts/lint.js')), ...walk(join(ROOT, 'console'), '.html'), ...walk(join(ROOT, 'landing'), '.html')];
for (const file of framingFiles) {
  const text = readFileSync(file, 'utf8');
  for (const [i, line] of text.split('\n').entries()) {
    const m = FORBIDDEN_FRAMING.exec(line);
    // Allow lines that explicitly NEGATE the framing ("never wagering", "not gambling").
    if (m && !/never|not a|no |NEVER|guard/i.test(line)) {
      failures.push(`framing: ${file}:${i + 1} uses "${m[0]}" — PunditPay is tipping, never betting`);
    }
  }
}

// ── 3. zero-cloud guard (src only — docs may cite for comparison) ──
const CLOUD_AI_HOSTS = /(api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.mistral\.ai|api\.cohere\.ai|openrouter\.ai)/i;
for (const file of jsFiles.filter((f) => f.includes('/src/'))) {
  const text = readFileSync(file, 'utf8');
  const m = CLOUD_AI_HOSTS.exec(text);
  if (m) failures.push(`zero-cloud: ${file} references ${m[0]} — all AI must run on-device via @qvac/sdk`);
}

// ── 4. no TODO/FIXME shipped in src ──
for (const file of jsFiles.filter((f) => f.includes('/src/') || f.includes('/bin/'))) {
  const text = readFileSync(file, 'utf8');
  for (const [i, line] of text.split('\n').entries()) {
    if (/\b(TODO|FIXME|XXX|HACK)\b/.test(line)) {
      failures.push(`todo: ${file}:${i + 1} — unfinished marker in shipped code`);
    }
  }
}

if (failures.length > 0) {
  console.error(`✖ lint failed (${failures.length} finding${failures.length === 1 ? '' : 's'}):\n`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`✔ lint clean — ${jsFiles.length} JS files: syntax ✓, framing guard ✓, zero-cloud guard ✓, no TODOs ✓`);
