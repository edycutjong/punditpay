/**
 * Console XSS regression guard (audit C1).
 *
 * The agent console renders its ledger — which, in the product's real threat
 * model (a third-party creator's tip jar), carries a server-controlled
 * `explorerUrl` in the payment receipt. That value reaches the DOM, so it must
 * never be interpolated raw into innerHTML/href. There's no DOM in node:test
 * (and adding jsdom would break the "3 deps, all Tether" invariant), so this is
 * a source-level guard: it fails if anyone reintroduces the raw interpolation
 * or removes the escaping helpers.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const html = readFileSync(fileURLToPath(new URL('../console/index.html', import.meta.url)), 'utf8');

describe('console: XSS-safe rendering of untrusted ledger data', () => {
  it('defines the escape + safe-url helpers', () => {
    assert.match(html, /function esc\(/, 'esc() helper present');
    assert.match(html, /function safeUrl\(/, 'safeUrl() helper present');
    assert.match(html, /function escapeHtml\(/, 'escapeHtml() helper present');
  });

  it('safeUrl only admits http(s) URLs', () => {
    // Extract and evaluate the exact regex the page uses.
    const m = /function safeUrl\(u\)\s*\{[^}]*?(\/\^https[^;]*?\/i)/.exec(html);
    assert.ok(m, 'safeUrl regex found');
    const re = eval(m[1]); // eslint-disable-line no-eval — testing the literal from source
    assert.equal(re.test('https://www.sparkscan.io/tx/abc'), true);
    assert.equal(re.test('http://localhost/x'), true);
    assert.equal(re.test('javascript:alert(1)'), false);
    assert.equal(re.test('"><script>alert(1)</script>'), false);
    assert.equal(re.test('data:text/html,<script>'), false);
    assert.equal(re.test('  https://x'), false); // must start with the scheme
  });

  it('never interpolates explorerUrl/link raw into an href', () => {
    // A raw `href="${...explorerUrl...}"` or `href="${link}"` (without esc/safeUrl) is the bug.
    assert.doesNotMatch(html, /href="\$\{d\.explorerUrl\}"/, 'raw d.explorerUrl in href');
    assert.doesNotMatch(html, /href="\$\{link\}"/, 'raw link in href');
  });

  it('routes explorerUrl through safeUrl before rendering', () => {
    assert.match(html, /safeUrl\(d\.explorerUrl\)/, 'history row guards explorerUrl');
    assert.match(html, /safeUrl\(link\)/, 'flash guards link');
    // The href, when present, is the escaped safe url.
    assert.match(html, /href="\$\{esc\(url\)\}"/, 'href uses esc(url)');
  });

  it('escapes the dynamic table-cell values (amount, txHash, entry text)', () => {
    assert.match(html, /esc\(d\.amount/, 'amount escaped');
    assert.match(html, /esc\(short\(d\.txHash\)\)/, 'txHash escaped');
    assert.match(html, /esc\(entry\.text\)/, 'entry text escaped');
  });
});
