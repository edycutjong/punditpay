/**
 * USD₮ amounts as bigint micros (6 decimals) — no floats anywhere near money.
 * "0.10" USDT === 100000n micros. Settlement adapters convert to their own
 * smallest unit (Spark: sats) at a fixed, disclosed demo rate.
 */

export const USDT_DECIMALS = 6;
export const MICROS_PER_USDT = 10n ** BigInt(USDT_DECIMALS);

const AMOUNT_RE = /^(\d+)(?:\.(\d{1,6}))?$/;

/** Parse a decimal USDT string ("0.10") into bigint micros. Throws on bad input. */
export function parseUSDT(text) {
  if (typeof text !== 'string') throw new MoneyError(`amount must be a string, got ${typeof text}`);
  const m = AMOUNT_RE.exec(text.trim());
  if (!m) throw new MoneyError(`invalid USDT amount: ${JSON.stringify(text)}`);
  const whole = BigInt(m[1]);
  const frac = BigInt((m[2] ?? '').padEnd(USDT_DECIMALS, '0'));
  return whole * MICROS_PER_USDT + frac;
}

/** Format bigint micros back into a decimal USDT string ("0.10"). */
export function formatUSDT(micros) {
  if (typeof micros !== 'bigint') throw new MoneyError(`micros must be a bigint, got ${typeof micros}`);
  if (micros < 0n) throw new MoneyError('negative amounts are not representable');
  const whole = micros / MICROS_PER_USDT;
  const frac = (micros % MICROS_PER_USDT).toString().padStart(USDT_DECIMALS, '0');
  const trimmed = frac.replace(/0+$/, '');
  return trimmed.length > 0 ? `${whole}.${trimmed.padEnd(2, '0')}` : `${whole}.00`;
}

/** True when `text` is a well-formed, strictly positive USDT amount. */
export function isValidAmount(text) {
  try {
    return parseUSDT(text) > 0n;
  } catch {
    return false;
  }
}

export class MoneyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MoneyError';
  }
}
