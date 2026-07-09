/**
 * Action ledger — every agent decision and payment, explained in plain
 * language, with the tx hash when there is one. This is the session's single
 * source of truth: the policy engine reads its totals, the console streams
 * its entries, and DEMO.md quotes its lines.
 */

import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { formatUSDT } from './money.js';

export const ENTRY_KINDS = Object.freeze([
  'info', // narration: match events, mode banners
  'reasoning', // the brain's streamed thinking for a moment
  'decision', // a decline ("held back — below my threshold")
  'payment', // a settled tip or pick purchase (has txHash)
  'blocked', // PolicyViolationError — the guardrail firing
  'error', // settlement/protocol failures
]);

export class ActionLedger extends EventEmitter {
  /** @param {{persistPath?: string, clock?: () => number}} opts */
  constructor({ persistPath = null, clock = Date.now } = {}) {
    super();
    this.persistPath = persistPath;
    this.clock = clock;
    this._entries = [];
    if (persistPath) mkdirSync(dirname(persistPath), { recursive: true });
  }

  /** Append an entry; returns the enriched entry. */
  append(kind, text, data = {}) {
    if (!ENTRY_KINDS.includes(kind)) throw new Error(`unknown ledger kind: ${kind}`);
    const entry = {
      seq: this._entries.length + 1,
      ts: new Date(this.clock()).toISOString(),
      kind,
      text,
      data,
    };
    this._entries.push(entry);
    if (this.persistPath) {
      appendFileSync(this.persistPath, `${JSON.stringify(entry, jsonBigint)}\n`, 'utf8');
    }
    this.emit('entry', entry);
    return entry;
  }

  entries() {
    return [...this._entries];
  }

  ofKind(kind) {
    return this._entries.filter((e) => e.kind === kind);
  }

  /** Session accounting — feeds the policy conditions. All bigint micros. */
  spentMicros() {
    return this.ofKind('payment').reduce((sum, e) => sum + BigInt(e.data.amountMicros ?? 0), 0n);
  }

  tipCount() {
    return this.ofKind('payment').filter((e) => e.data.operation === 'pay_tip').length;
  }

  pickCount() {
    return this.ofKind('payment').filter((e) => e.data.operation === 'buy_pick').length;
  }

  blockedCount() {
    return this.ofKind('blocked').length;
  }

  /** The session accountant view the policy layer consumes. */
  get session() {
    return {
      spentMicros: () => this.spentMicros(),
      tipCount: () => this.tipCount(),
      pickCount: () => this.pickCount(),
    };
  }

  /** Human summary used by the console footer and demo epilogue. */
  summary() {
    return {
      entries: this._entries.length,
      payments: this.ofKind('payment').length,
      tips: this.tipCount(),
      picks: this.pickCount(),
      blocked: this.blockedCount(),
      declined: this.ofKind('decision').length,
      spent: formatUSDT(this.spentMicros()),
    };
  }
}

/** Plain-language helpers so every log line reads like a sentence, not a dump. */
export function describePayment({ operation, amount, to, reason, txHash }) {
  const verb = operation === 'buy_pick' ? 'Bought pick from' : 'Tipped';
  const money = operation === 'buy_pick' ? `for ${amount} USD₮` : `${amount} USD₮ to`;
  return operation === 'buy_pick'
    ? `${verb} ${to} ${money} — ${reason}${txHash ? ` · tx ${shortHash(txHash)}` : ''}`
    : `${verb} ${money} ${to} — ${reason}${txHash ? ` · tx ${shortHash(txHash)}` : ''}`;
}

export function describeBlocked({ amount, to, reason }) {
  return `BLOCKED — PolicyViolationError: ${reason} (attempted ${amount} USD₮ to ${to})`;
}

export function shortHash(hash) {
  if (!hash || hash.length <= 14) return hash ?? '';
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

function jsonBigint(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}
