#!/usr/bin/env node
/**
 * punditpay — the CLI.
 *
 *   punditpay server [--wallet=local|spark] [--port=4021]
 *       run the x402 tip-jar resource server
 *
 *   punditpay agent  [--brain=qvac|rules] [--wallet=local|spark] [--console]
 *                    [--model=llama-tools-1b] [--pace=1200] [--tipjar-url=…]
 *       run the agent against a running tip jar
 *
 *   punditpay demo   [--brain=…] [--wallet=…] [--pace=…]
 *       tip jar + agent + console in one process — the full scripted match
 */

import process from 'node:process';
import { loadEnv } from '../src/util/env.js';
import { ActionLedger } from '../src/core/ledger.js';
import { loadMatchFeed } from '../src/core/matchfeed.js';
import { createTipJar, listen } from '../src/server/tipjar.js';
import { createConsoleServer, consoleState } from '../src/server/console.js';
import { createRulesBrain } from '../src/agent/brain-rules.js';
import { createQvacBrain, DEFAULT_MODEL } from '../src/agent/brain-qvac.js';
import { createLocalWallet, localVerifier, LOCAL_NETWORK, deriveAddress } from '../src/wallet/devsigner.js';
import { createAgent, DEFAULT_LIMITS, DEFAULT_RULE, AGENT_TOOLS } from '../src/agent/agent.js';
import { parseUSDT } from '../src/core/money.js';
import { createHash } from 'node:crypto';

loadEnv();

const KNOWN_FLAGS = new Set(['brain', 'wallet', 'model', 'pace', 'port', 'console-port', 'tipjar-url', 'console', 'no-persist']);

const [, , command = 'demo', ...rest] = process.argv;
const flags = parseFlags(rest);

// Reject unknown --brain/--wallet rather than silently falling back — a
// typo'd `--wallet=sprak` must never quietly run local-sim while the operator
// thinks they're on testnet.
assertChoice('brain', flags.brain, ['qvac', 'rules']);
assertChoice('wallet', flags.wallet, ['local', 'spark']);
if (flags.pace != null && !Number.isFinite(Number(flags.pace))) fail(`--pace must be a number, got ${JSON.stringify(flags.pace)}`);
for (const portFlag of ['port', 'console-port']) {
  if (flags[portFlag] != null && !Number.isInteger(Number(flags[portFlag]))) fail(`--${portFlag} must be an integer, got ${JSON.stringify(flags[portFlag])}`);
}

const config = {
  brain: flags.brain ?? 'rules',
  wallet: flags.wallet ?? 'local',
  model: flags.model ?? DEFAULT_MODEL,
  paceMs: flags.pace != null ? Number(flags.pace) : 1200,
  tipjarPort: Number(flags.port ?? process.env.TIPJAR_PORT ?? 4021),
  consolePort: Number(flags['console-port'] ?? process.env.CONSOLE_PORT ?? 4020),
  tipjarUrl: flags['tipjar-url'] ?? process.env.TIPJAR_URL ?? null,
  network: process.env.SPARK_NETWORK ?? 'TESTNET',
  withConsole: Boolean(flags.console) || command === 'demo',
};

try {
  if (command === 'server') await runServer();
  else if (command === 'agent') await runAgent({ startServer: false });
  else if (command === 'demo') await runAgent({ startServer: true });
  else usage();
} catch (err) {
  console.error(`✖ ${err.message}`);
  process.exit(1);
}

async function buildTipjar() {
  if (config.wallet === 'spark') {
    const { sparkVerifier, microsToSats, SATS_PER_USDT, explorerUrlFor, sparkNetworkName } = await import('../src/wallet/wdk-spark.js');
    const { createSparkWallet } = await import('../src/wallet/wdk-spark.js');
    const jarSeed = process.env.TIPJAR_SEED_PHRASE;
    if (!jarSeed) throw new Error('spark mode: set TIPJAR_SEED_PHRASE in .env (npm run keygen)');
    const jarWallet = await createSparkWallet({ seedPhrase: jarSeed, network: config.network });
    const jarAddress = await jarWallet.getAddress();
    console.log(`💰 tip jar spark address (${config.network}): ${jarAddress}`);
    return createTipJar({
      verifier: sparkVerifier({ network: config.network }),
      network: sparkNetworkName(config.network),
      payToFor: () => jarAddress,
      explorerUrlFor: (txHash) => explorerUrlFor(txHash, config.network),
      settlementFor: (amountMicros) => ({
        unit: 'sat',
        satsPerUsdt: SATS_PER_USDT.toString(),
        value: microsToSats(amountMicros).toString(),
        note: 'demo conversion rate, disclosed in README',
      }),
    });
  }
  return createTipJar({
    verifier: localVerifier(),
    network: LOCAL_NETWORK,
    payToFor: (handle) => deriveAddress(createHash('sha256').update(`jar:${handle}`).digest()),
  });
}

async function buildWallet(agentLedger) {
  if (config.wallet === 'spark') {
    const { createSparkWallet, microsToSats } = await import('../src/wallet/wdk-spark.js');
    const seed = process.env.PUNDITPAY_SEED_PHRASE;
    if (!seed) throw new Error('spark mode: set PUNDITPAY_SEED_PHRASE in .env (npm run keygen)');
    return createSparkWallet({
      seedPhrase: seed,
      network: config.network,
      policyLimits: { sessionCapSettleUnits: microsToSats(parseUSDT(DEFAULT_LIMITS.sessionCap)) },
      policySession: { spentSettleUnits: () => microsToSats(agentLedger.spentMicros()) },
    });
  }
  return createLocalWallet({ label: 'agent' });
}

function buildBrain() {
  if (config.brain === 'qvac') {
    return createQvacBrain({
      model: config.model,
      tools: AGENT_TOOLS,
      onProgress: (p) => {
        const line = `▸ model download ${p.percentage.toFixed(0)}% (${(p.downloaded / 1e6).toFixed(0)}/${(p.total / 1e6).toFixed(0)} MB)`;
        process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
        if (p.percentage >= 100) process.stderr.write('\n');
      },
    });
  }
  return createRulesBrain();
}

async function runServer() {
  const jar = await buildTipjar();
  const url = await listen(jar.server, config.tipjarPort);
  console.log(`⚽ PunditPay tip jar listening on ${url}  (x402 · network: ${config.wallet === 'spark' ? `spark-${config.network.toLowerCase()}` : LOCAL_NETWORK})`);
  console.log(`   try: curl -i ${url}/tip/@vantage`);
}

async function runAgent({ startServer }) {
  const ledger = new ActionLedger({ persistPath: flags['no-persist'] ? null : 'var/ledger.jsonl' });

  let tipjarUrl = config.tipjarUrl;
  if (startServer || !tipjarUrl) {
    const jar = await buildTipjar();
    tipjarUrl = await listen(jar.server, startServer ? config.tipjarPort : 0);
    console.log(`⚽ tip jar up at ${tipjarUrl}`);
  }

  const wallet = await buildWallet(ledger);
  const brain = buildBrain();
  const agent = createAgent({
    feed: loadMatchFeed(),
    brain,
    wallet,
    ledger,
    tipjarUrl,
    rule: DEFAULT_RULE,
    limits: DEFAULT_LIMITS,
    paceMs: config.paceMs,
  });

  if (config.withConsole) {
    const consoleSrv = createConsoleServer({
      ledger,
      getState: () => consoleState({ ledger, agent, brain, wallet }),
    });
    const consoleUrl = await listen(consoleSrv.server, config.consolePort);
    console.log(`🖥  agent console: ${consoleUrl}  (open in a browser — reasoning streams live)`);
  }

  // Mirror the ledger to the terminal with kind-appropriate colors.
  ledger.on('entry', (entry) => {
    const paint = { info: 90, reasoning: 36, decision: 33, payment: 32, blocked: 31, error: 31 }[entry.kind] ?? 0;
    console.log(`\x1b[${paint}m${prefix(entry.kind)} ${entry.text}\x1b[0m`);
  });

  const summary = await agent.runSession();
  console.log(`\n✔ done — ${summary.tips} tips, ${summary.picks} pick, ${summary.spent} USD₮ spent, ${summary.blocked} blocked, ${summary.declined} declined`);
  if (config.withConsole) {
    console.log('  console stays up — Ctrl-C when finished.');
  } else {
    await brain.dispose();
    process.exit(0);
  }
}

function prefix(kind) {
  return { info: ' · ', reasoning: ' 🧠', decision: ' ✋', payment: ' ✅', blocked: ' ⛔', error: ' ✖ ' }[kind] ?? '   ';
}

function parseFlags(args) {
  const out = {};
  for (const arg of args) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!m) fail(`unrecognized argument: ${arg}`);
    else if (!KNOWN_FLAGS.has(m[1])) fail(`unknown flag: --${m[1]} (known: ${[...KNOWN_FLAGS].map((f) => `--${f}`).join(' ')})`);
    else out[m[1]] = m[2] ?? true;
  }
  return out;
}

function assertChoice(name, value, allowed) {
  if (value != null && value !== true && !allowed.includes(value)) {
    fail(`--${name} must be one of ${allowed.join('|')}, got ${JSON.stringify(value)}`);
  }
  if (value === true) fail(`--${name} needs a value (${allowed.join('|')})`);
}

function fail(message) {
  console.error(`✖ ${message}`);
  usage();
}

function usage() {
  console.log('usage: punditpay <server|agent|demo> [--brain=qvac|rules] [--wallet=local|spark] [--console] [--pace=ms] [--model=qwen-1.7b|llama-tools-1b|qwen-600m|llama-1b]');
  process.exit(2);
}
