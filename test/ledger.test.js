import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionLedger, describeBlocked, describePayment, shortHash } from '../src/core/ledger.js';

describe('ledger: entries', () => {
  it('appends entries with monotonic seq and ISO timestamps', () => {
    const ledger = new ActionLedger();
    const a = ledger.append('info', 'kickoff');
    const b = ledger.append('reasoning', 'thinking');
    assert.equal(a.seq, 1);
    assert.equal(b.seq, 2);
    assert.ok(!Number.isNaN(Date.parse(a.ts)));
  });

  it('rejects unknown kinds', () => {
    assert.throws(() => new ActionLedger().append('vibes', 'nope'));
  });

  it('emits an event per entry (the console feed)', () => {
    const ledger = new ActionLedger();
    const seen = [];
    ledger.on('entry', (e) => seen.push(e.kind));
    ledger.append('info', 'a');
    ledger.append('payment', 'b', { amountMicros: 1n, operation: 'pay_tip' });
    assert.deepEqual(seen, ['info', 'payment']);
  });

  it('entries() returns a copy, not the live array', () => {
    const ledger = new ActionLedger();
    ledger.append('info', 'a');
    ledger.entries().push({ fake: true });
    assert.equal(ledger.entries().length, 1);
  });
});

describe('ledger: session accounting (what the policy reads)', () => {
  it('sums spent micros across tips and picks only', () => {
    const ledger = new ActionLedger();
    ledger.append('payment', 'tip', { amountMicros: 150_000n, operation: 'pay_tip' });
    ledger.append('payment', 'pick', { amountMicros: 250_000n, operation: 'buy_pick' });
    ledger.append('blocked', 'blocked', { amountMicros: 999_999n, operation: 'pay_tip' });
    ledger.append('decision', 'declined', {});
    assert.equal(ledger.spentMicros(), 400_000n);
  });

  it('counts tips and picks separately', () => {
    const ledger = new ActionLedger();
    ledger.append('payment', 'tip', { amountMicros: 1n, operation: 'pay_tip' });
    ledger.append('payment', 'tip', { amountMicros: 1n, operation: 'pay_tip' });
    ledger.append('payment', 'pick', { amountMicros: 1n, operation: 'buy_pick' });
    assert.equal(ledger.tipCount(), 2);
    assert.equal(ledger.pickCount(), 1);
  });

  it('blocked attempts never count as spending — the cap is unbreachable in the books too', () => {
    const ledger = new ActionLedger();
    ledger.append('blocked', 'x', { amountMicros: 500_000n, operation: 'pay_tip' });
    assert.equal(ledger.spentMicros(), 0n);
    assert.equal(ledger.blockedCount(), 1);
  });

  it('summary reports the human numbers', () => {
    const ledger = new ActionLedger();
    ledger.append('payment', 'tip', { amountMicros: 150_000n, operation: 'pay_tip' });
    ledger.append('decision', 'held back', {});
    const s = ledger.summary();
    assert.equal(s.tips, 1);
    assert.equal(s.declined, 1);
    assert.equal(s.spent, '0.15');
  });

  it('session view exposes live closures for the policy engine', () => {
    const ledger = new ActionLedger();
    const session = ledger.session;
    assert.equal(session.spentMicros(), 0n);
    ledger.append('payment', 'tip', { amountMicros: 100n, operation: 'pay_tip' });
    assert.equal(session.spentMicros(), 100n);
  });
});

describe('ledger: persistence', () => {
  it('writes JSONL with bigints stringified', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'punditpay-')), 'ledger.jsonl');
    const ledger = new ActionLedger({ persistPath: path });
    ledger.append('payment', 'tip', { amountMicros: 150_000n, operation: 'pay_tip' });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).data.amountMicros, '150000');
  });
});

describe('ledger: plain-language rendering', () => {
  it('describePayment reads like a sentence with a short hash', () => {
    const text = describePayment({ operation: 'pay_tip', amount: '0.10', to: '@vantage', reason: 'called the winner', txHash: 'abcdef1234567890abcdef' });
    assert.match(text, /^Tipped 0\.10 USD₮ to @vantage — called the winner · tx abcdef12…abcdef$/);
  });

  it('describePayment renders pick purchases distinctly', () => {
    const text = describePayment({ operation: 'buy_pick', amount: '0.25', to: '@tacticsroom', reason: 'half-time read', txHash: null });
    assert.match(text, /^Bought pick from @tacticsroom for 0\.25 USD₮/);
  });

  it('describeBlocked names PolicyViolationError explicitly', () => {
    const text = describeBlocked({ amount: '0.25', to: '@vantage', reason: 'would exceed session cap' });
    assert.match(text, /BLOCKED — PolicyViolationError: would exceed session cap/);
  });

  it('shortHash keeps short hashes intact and shortens long ones', () => {
    assert.equal(shortHash('abc'), 'abc');
    assert.equal(shortHash('0123456789abcdefghij'), '01234567…efghij');
    assert.equal(shortHash(null), '');
  });
});
