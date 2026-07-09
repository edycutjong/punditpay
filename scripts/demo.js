#!/usr/bin/env node
/**
 * One-shot demo: tip jar + agent + live console in one process, paced for
 * humans. Equivalent to `node bin/punditpay.js demo` — kept as a script so
 * `npm run demo` matches the README and DEMO.md exactly.
 *
 * Flags pass straight through, e.g.:
 *   npm run demo -- --brain=qvac            (real on-device model)
 *   npm run demo -- --wallet=spark          (real Spark testnet settlement)
 *   npm run demo -- --pace=400              (impatient mode)
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/punditpay.js', import.meta.url));
const child = spawn(process.execPath, [bin, 'demo', ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
