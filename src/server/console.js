/**
 * Console server — serves the self-contained agent console UI and streams
 * the ledger to it over Server-Sent Events. Localhost only; the UI makes
 * zero external requests (no CDNs, no fonts, no cloud — same story as the
 * agent itself).
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatUSDT } from '../core/money.js';

const CONSOLE_HTML = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'console', 'index.html');

/**
 * @param {{ledger: import('../core/ledger.js').ActionLedger, getState: () => object}} opts
 */
export function createConsoleServer({ ledger, getState }) {
  const clients = new Set();

  ledger.on('entry', (entry) => {
    const frame = `event: entry\ndata: ${JSON.stringify(entry, bigintSafe)}\n\n`;
    for (const res of clients) res.write(frame);
    const stateFrame = `event: state\ndata: ${JSON.stringify(getState(), bigintSafe)}\n\n`;
    for (const res of clients) res.write(stateFrame);
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(readFileSync(CONSOLE_HTML, 'utf8'));
    }
    if (url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      // Replay history so a late-joining browser sees the full session.
      for (const entry of ledger.entries()) {
        res.write(`event: entry\ndata: ${JSON.stringify(entry, bigintSafe)}\n\n`);
      }
      res.write(`event: state\ndata: ${JSON.stringify(getState(), bigintSafe)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(getState(), bigintSafe));
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
  });

  return { server, clients };
}

/** Build the live state object the cap meter + chips render from. */
export function consoleState({ ledger, agent, brain, wallet }) {
  const cap = agent.capState();
  const summary = ledger.summary();
  return {
    brain: { kind: brain.kind, label: brain.label },
    wallet: { kind: wallet.kind, label: wallet.label, network: wallet.network },
    rule: agent.rule,
    limits: agent.limits,
    spent: formatUSDT(cap.spentMicros),
    cap: formatUSDT(cap.capMicros),
    spentPct: Number((cap.spentMicros * 100n) / (cap.capMicros === 0n ? 1n : cap.capMicros)),
    tipsLeft: cap.tipsLeft,
    summary,
  };
}

function bigintSafe(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}
