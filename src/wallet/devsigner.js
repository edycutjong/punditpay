/**
 * Local dev wallet — real ed25519 keys via node:crypto, zero dependencies.
 *
 * This is the `--wallet=local` mode: the x402 round-trip stays fully
 * cryptographically real (keys generated on-device, payments signed, the
 * server verifies signature AND address↔pubkey binding) while settlement is
 * simulated. The network is honestly labeled `local-sim` everywhere it
 * appears — swap in the Spark adapter (`--wallet=spark`) for on-chain
 * testnet settlement with the exact same interface.
 */

import { createHash, generateKeyPairSync, randomBytes, sign as edSign, verify as edVerify } from 'node:crypto';

export const LOCAL_NETWORK = 'local-sim';

/** Derive a display address from a raw public key: pndt1 + first 20 bytes of sha256(pubkey), hex. */
export function deriveAddress(publicKeyRaw) {
  const digest = createHash('sha256').update(publicKeyRaw).digest();
  return `pndt1${digest.subarray(0, 20).toString('hex')}`;
}

/** Extract the raw 32-byte ed25519 public key from a DER-encoded SPKI export. */
function rawFromSpki(spkiDer) {
  return spkiDer.subarray(spkiDer.length - 32);
}

export function createLocalWallet({ label = 'agent' } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyRaw = rawFromSpki(publicKey.export({ type: 'spki', format: 'der' }));
  const address = deriveAddress(publicKeyRaw);

  return {
    kind: 'local',
    network: LOCAL_NETWORK,
    label,

    async getAddress() {
      return address;
    },

    /** Raw public key, base64 — travels inside the payment payload for verification. */
    publicKeyB64() {
      return publicKeyRaw.toString('base64');
    },

    /** Sign arbitrary bytes (the canonical payment payload). */
    async signBytes(bytes) {
      return edSign(null, bytes, privateKey).toString('base64');
    },

    /**
     * "Settle" the offer locally: no chain, so the tx hash is an honest
     * fingerprint of the payment itself, prefixed so nobody mistakes it
     * for an on-chain hash.
     */
    async settle(offer) {
      const fingerprint = createHash('sha256')
        .update(JSON.stringify({ offer: offer.nonce, from: address, at: Date.now(), salt: randomBytes(8).toString('hex') }))
        .digest('hex');
      return {
        txHash: `sim-${fingerprint.slice(0, 40)}`,
        from: address,
        network: LOCAL_NETWORK,
        explorerUrl: null,
      };
    },

    /** Balance is a fiction in local-sim mode; report it as such. */
    async getBalance() {
      return { simulated: true, note: 'local-sim wallet has no chain balance' };
    },

    dispose() {
      // node:crypto KeyObjects are GC-managed; nothing sensitive persisted.
    },
  };
}

/**
 * Server-side verifier for local-mode payments:
 *  1. the payload must carry the payer's raw public key,
 *  2. the claimed `from` address must be derived from that exact key,
 *  3. the ed25519 signature must verify over the canonical bytes.
 * A forged key fails (2); a tampered payload fails (3).
 */
export function localVerifier() {
  return async ({ payment, bytes }) => {
    if (!payment.fromPublicKey || !payment.signature) return false;
    let publicKeyRaw;
    try {
      publicKeyRaw = Buffer.from(payment.fromPublicKey, 'base64');
    } catch {
      return false;
    }
    if (publicKeyRaw.length !== 32) return false;
    if (deriveAddress(publicKeyRaw) !== payment.from) return false;
    const spki = Buffer.concat([ED25519_SPKI_PREFIX, publicKeyRaw]);
    try {
      const keyObject = await importSpki(spki);
      return edVerify(null, bytes, keyObject, Buffer.from(payment.signature, 'base64'));
    } catch {
      return false;
    }
  };
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

async function importSpki(spkiDer) {
  const { createPublicKey } = await import('node:crypto');
  return createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
}
