/**
 * Spark settlement adapter — the `--wallet=spark` mode.
 *
 * Real self-custodial keys via @tetherto/wdk (BIP-39 seed, on-device), real
 * zero-fee Spark transfers via @tetherto/wdk-wallet-spark, and the WDK
 * Transaction-Policy engine registered IN the wallet as the second
 * enforcement layer (the core PolicyEngine is the first — pre-flight).
 *
 * Tips are USD₮-denominated in the x402 offer and settle on Spark testnet in
 * sats at a fixed, disclosed demo rate (see SATS_PER_USDT below). Spark
 * transfers are zero-fee, which is what makes cent-sized tips economical.
 *
 * All SDK imports are dynamic so `--wallet=local` sessions, tests, and
 * verify_offline never load native wallet code.
 */

import { buildWdkPolicy } from '../core/policy.js';
import { MICROS_PER_USDT } from '../core/money.js';

/** Demo conversion rate, disclosed in README + AUDIT_REPORT: 1 USD₮ ⇒ 1,000 sats. */
export const SATS_PER_USDT = 1000n;

export function microsToSats(micros) {
  return (micros * SATS_PER_USDT) / MICROS_PER_USDT;
}

export function sparkNetworkName(network) {
  return `spark-${String(network).toLowerCase()}`;
}

export function explorerUrlFor(txHash, network) {
  const suffix = String(network).toUpperCase() === 'MAINNET' ? '' : `?network=${String(network).toLowerCase()}`;
  return `https://www.sparkscan.io/tx/${txHash}${suffix}`;
}

/* node:coverage disable */ // live @tetherto/wdk + @tetherto/wdk-wallet-spark: real BIP-39 keys, testnet account + zero-fee transfers — proven by the manual `--wallet=spark` run + Spark explorer link, not by CI (the pure sats/network/explorer helpers below ARE unit-tested)
/**
 * @param {{seedPhrase: string, network?: 'TESTNET'|'REGTEST'|'MAINNET',
 *          accountIndex?: number,
 *          policyLimits?: {sessionCapSettleUnits: bigint},
 *          policySession?: {spentSettleUnits: () => bigint}}} opts
 */
export async function createSparkWallet({ seedPhrase, network = 'TESTNET', accountIndex = 0, policyLimits, policySession }) {
  if (!seedPhrase) throw new Error('SPARK wallet needs a BIP-39 seed phrase (run `npm run keygen`, set PUNDITPAY_SEED_PHRASE)');
  const [{ default: WDK }, { default: WalletManagerSpark }] = await Promise.all([
    import('@tetherto/wdk'),
    import('@tetherto/wdk-wallet-spark'),
  ]);
  if (!WDK.isValidSeed(seedPhrase)) throw new Error('PUNDITPAY_SEED_PHRASE is not a valid BIP-39 phrase');

  const wdk = new WDK(seedPhrase).registerWallet('spark', WalletManagerSpark, { network });
  if (policyLimits && policySession) {
    // Second enforcement layer: the wallet itself refuses over-cap signatures.
    wdk.registerPolicy(buildWdkPolicy(policyLimits, policySession));
  }
  const account = await wdk.getAccount('spark', accountIndex);
  const address = await account.getAddress();
  const networkName = sparkNetworkName(network);

  return {
    kind: 'spark',
    network: networkName,
    label: `spark:${network}`,

    async getAddress() {
      return address;
    },

    /** Spark verification is address-bound (read-only account), no pubkey needed in the payload. */
    publicKeyB64() {
      return null;
    },

    /** Sign the canonical payment bytes with the wallet's identity key. */
    async signBytes(bytes) {
      return account.sign(bytes.toString('utf8'));
    },

    /**
     * Settle the offer on Spark: zero-fee transfer of the sats equivalent
     * (rate disclosed above) to the creator's Spark address.
     */
    async settle(offer) {
      const sats = offer.settlement?.value != null ? BigInt(offer.settlement.value) : microsToSats(microsFromOffer(offer));
      const result = await account.sendTransaction({ to: offer.payTo, value: Number(sats) });
      return {
        txHash: result.hash,
        from: address,
        network: networkName,
        explorerUrl: explorerUrlFor(result.hash, network),
      };
    },

    async getBalance() {
      return { sats: await account.getBalance() };
    },

    dispose() {
      wdk.dispose();
    },
  };
}

function microsFromOffer(offer) {
  // Offer amounts are validated decimal USD₮ strings; parse without importing parseUSDT circularly.
  const [whole, frac = ''] = offer.amount.split('.');
  return BigInt(whole) * MICROS_PER_USDT + BigInt(frac.padEnd(6, '0'));
}

/**
 * Server-side verifier for spark payments — needs no keys, only the network:
 *  1. reconstruct a read-only account for the CLAIMED payer address,
 *  2. the ed25519/FROST identity signature must verify over the canonical bytes,
 *  3. the referenced Spark transfer must actually exist on-chain.
 */
export function sparkVerifier({ network = 'TESTNET' } = {}) {
  return async ({ payment, bytes }) => {
    try {
      const mod = await import('@tetherto/wdk-wallet-spark');
      const ReadOnly = mod.WalletAccountReadOnlySpark ?? mod.default?.WalletAccountReadOnlySpark;
      const readOnly = new ReadOnly(payment.from, { network });
      const signatureOk = await readOnly.verify(bytes.toString('utf8'), payment.signature);
      if (!signatureOk) return false;
      if (!payment.txHash) return false;
      const receipt = await readOnly.getTransactionReceipt(payment.txHash);
      return receipt != null;
    } catch {
      return false;
    }
  };
}
/* node:coverage enable */
