import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MICROS_PER_USDT, MoneyError, formatUSDT, isValidAmount, parseUSDT } from '../src/core/money.js';

describe('money: parseUSDT', () => {
  it('parses whole USDT', () => assert.equal(parseUSDT('1'), 1_000_000n));
  it('parses two-decimal cents', () => assert.equal(parseUSDT('0.10'), 100_000n));
  it('parses full six decimals', () => assert.equal(parseUSDT('0.000001'), 1n));
  it('parses a large amount', () => assert.equal(parseUSDT('12345.678901'), 12_345_678_901n));
  it('parses zero', () => assert.equal(parseUSDT('0'), 0n));
  it('trims surrounding whitespace', () => assert.equal(parseUSDT(' 0.25 '), 250_000n));
  it('rejects more than 6 decimals', () => assert.throws(() => parseUSDT('0.0000001'), MoneyError));
  it('rejects negative amounts', () => assert.throws(() => parseUSDT('-1'), MoneyError));
  it('rejects scientific notation', () => assert.throws(() => parseUSDT('1e6'), MoneyError));
  it('rejects thousands separators', () => assert.throws(() => parseUSDT('1,000'), MoneyError));
  it('rejects the empty string', () => assert.throws(() => parseUSDT(''), MoneyError));
  it('rejects non-strings', () => assert.throws(() => parseUSDT(0.1), MoneyError));
  it('rejects a lone dot', () => assert.throws(() => parseUSDT('.'), MoneyError));
});

describe('money: formatUSDT', () => {
  it('formats micros to cents', () => assert.equal(formatUSDT(100_000n), '0.10'));
  it('formats whole USDT with two decimals', () => assert.equal(formatUSDT(1_000_000n), '1.00'));
  it('keeps sub-cent precision when needed', () => assert.equal(formatUSDT(1n), '0.000001'));
  it('formats zero', () => assert.equal(formatUSDT(0n), '0.00'));
  it('round-trips with parseUSDT', () => {
    for (const s of ['0.05', '0.10', '0.25', '1.00', '3.50']) {
      assert.equal(formatUSDT(parseUSDT(s)), s);
    }
  });
  it('rejects negative micros', () => assert.throws(() => formatUSDT(-1n), MoneyError));
  it('rejects non-bigint input', () => assert.throws(() => formatUSDT(100000), MoneyError));
});

describe('money: isValidAmount', () => {
  it('accepts positive decimal strings', () => assert.equal(isValidAmount('0.10'), true));
  it('rejects zero (a tip must move money)', () => assert.equal(isValidAmount('0'), false));
  it('rejects garbage', () => assert.equal(isValidAmount('ten bucks'), false));
  it('rejects undefined', () => assert.equal(isValidAmount(undefined), false));
});

describe('money: constants', () => {
  it('MICROS_PER_USDT is 10^6', () => assert.equal(MICROS_PER_USDT, 1_000_000n));
});
