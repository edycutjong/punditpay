/**
 * The minimal .env loader (src/util/env.js).
 *
 * A dependency-free parser is only trustworthy if its edges are pinned: existing
 * environment wins, comments/blank/malformed lines are skipped, and a missing
 * file is a no-op rather than a crash. These exercise every branch in-process.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from '../src/util/env.js';

const scratch = mkdtempSync(join(tmpdir(), 'punditpay-env-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function writeEnv(name, body) {
  const path = join(scratch, name);
  writeFileSync(path, body, 'utf8');
  return path;
}

describe('env: loadEnv', () => {
  it('returns an empty object when the file does not exist (never throws)', () => {
    assert.deepEqual(loadEnv(join(scratch, 'does-not-exist.env')), {});
  });

  it('parses KEY=VALUE lines and returns everything it loaded', () => {
    const path = writeEnv('a.env', 'PUNDITPAY_A=one\nPUNDITPAY_B=two\n');
    const loaded = loadEnv(path);
    assert.equal(loaded.PUNDITPAY_A, 'one');
    assert.equal(loaded.PUNDITPAY_B, 'two');
    assert.equal(process.env.PUNDITPAY_A, 'one');
  });

  it('skips comments, blank lines, and lines with no "="', () => {
    const path = writeEnv('b.env', '# a comment\n\n   \nNOT_A_PAIR\nPUNDITPAY_C = trimmed \n');
    const loaded = loadEnv(path);
    assert.equal(loaded.PUNDITPAY_C, 'trimmed');
    assert.equal(Object.keys(loaded).length, 1, 'only the one real pair is loaded');
    assert.ok(!('NOT_A_PAIR' in loaded));
  });

  it('existing environment wins — a pre-set key is reported but not overwritten', () => {
    process.env.PUNDITPAY_EXISTING = 'original';
    const path = writeEnv('c.env', 'PUNDITPAY_EXISTING=fromfile\n');
    const loaded = loadEnv(path);
    // The file value is reported in the returned map...
    assert.equal(loaded.PUNDITPAY_EXISTING, 'fromfile');
    // ...but process.env keeps the value that was already there.
    assert.equal(process.env.PUNDITPAY_EXISTING, 'original');
    delete process.env.PUNDITPAY_EXISTING;
  });
});
