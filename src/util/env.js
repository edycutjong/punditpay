/** Minimal .env loader — no dependency, no surprises. Existing env wins. */

import { existsSync, readFileSync } from 'node:fs';

export function loadEnv(path = '.env') {
  if (!existsSync(path)) return {};
  const loaded = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    loaded[key] = value;
    if (!(key in process.env)) process.env[key] = value;
  }
  return loaded;
}
