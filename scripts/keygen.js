#!/usr/bin/env node
/**
 * Generate a fresh BIP-39 seed phrase for the agent (or the tip jar) using
 * WDK's own seed utilities. Run twice — one phrase per identity — and put
 * them in .env as PUNDITPAY_SEED_PHRASE / TIPJAR_SEED_PHRASE.
 *
 * The phrase is printed once and never stored by this script.
 */

const { default: WDK } = await import('@tetherto/wdk');

const phrase = WDK.getRandomSeedPhrase();
if (!WDK.isValidSeed(phrase)) {
  console.error('✖ generated phrase failed validation — try again');
  process.exit(1);
}

console.log('Your new BIP-39 seed phrase (write it down, keep it OFF this machine if it will ever hold real funds):\n');
console.log(`  ${phrase}\n`);
console.log('Add to .env as PUNDITPAY_SEED_PHRASE=… (agent) or TIPJAR_SEED_PHRASE=… (tip jar).');
