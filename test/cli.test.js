/**
 * CLI argument validation (audit C2).
 *
 * A typo'd flag must fail loudly, never silently fall back — a `--wallet=sprak`
 * that quietly runs local-sim while the operator believes they're on testnet is
 * exactly the kind of demo-day embarrassment this guards against.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const BIN = fileURLToPath(new URL('../bin/punditpay.js', import.meta.url));

async function cli(args) {
  try {
    const { stdout, stderr } = await run('node', [BIN, ...args], { timeout: 15_000 });
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    return { code: err.code ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

describe('cli: rejects bad input with exit 2 (never a silent fallback)', () => {
  it('an unknown flag is rejected', async () => {
    const { code, out } = await cli(['agent', '--turbo', '--no-persist']);
    assert.equal(code, 2);
    assert.match(out, /unknown flag: --turbo/);
  });

  it('a misspelled --wallet is rejected, not silently downgraded to local', async () => {
    const { code, out } = await cli(['agent', '--wallet=sprak', '--no-persist']);
    assert.equal(code, 2);
    assert.match(out, /--wallet must be one of local\|spark/);
  });

  it('a misspelled --brain is rejected', async () => {
    const { code, out } = await cli(['agent', '--brain=gpt4', '--no-persist']);
    assert.equal(code, 2);
    assert.match(out, /--brain must be one of qvac\|rules/);
  });

  it('a non-numeric --pace is rejected', async () => {
    const { code, out } = await cli(['agent', '--pace=fast', '--no-persist']);
    assert.equal(code, 2);
    assert.match(out, /--pace must be a number/);
  });

  it('a value-less --brain is rejected', async () => {
    const { code } = await cli(['agent', '--brain', '--no-persist']);
    assert.equal(code, 2);
  });

  it('a stray positional argument is rejected', async () => {
    const { code, out } = await cli(['agent', 'hello', '--no-persist']);
    assert.equal(code, 2);
    assert.match(out, /unrecognized argument: hello/);
  });

  it('an unknown command prints usage and exits 2', async () => {
    const { code, out } = await cli(['bogus-command']);
    assert.equal(code, 2);
    assert.match(out, /usage: punditpay/);
  });
});

describe('cli: valid input runs the full scripted session', () => {
  it('rules/local completes with the engineered books', async () => {
    const { code, out } = await cli(['agent', '--brain=rules', '--wallet=local', '--pace=0', '--no-persist']);
    assert.equal(code, 0);
    assert.match(out, /done — 4 tips, 1 pick, 1\.00 USD₮ spent, 1 blocked, 3 declined/);
  });
});
