import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_NETWORK, createLocalWallet, deriveAddress, localVerifier } from '../src/wallet/devsigner.js';
import { buildOffer, buildPaymentPayload, canonicalPaymentBytes } from '../src/core/x402.js';

async function signedPayment(wallet, overrides = {}) {
  const offer = buildOffer({ resource: '/tip/@vantage', payTo: 'jar-v', network: LOCAL_NETWORK, amount: '0.10' }).accepts[0];
  const settlement = await wallet.settle(offer);
  const unsigned = { ...buildPaymentPayload({ offer, from: settlement.from, txHash: settlement.txHash }), fromPublicKey: wallet.publicKeyB64() };
  const signature = await wallet.signBytes(canonicalPaymentBytes(unsigned));
  return { ...unsigned, signature, ...overrides };
}

describe('devsigner: keys and addresses', () => {
  it('creates distinct keypairs per wallet', async () => {
    const [a, b] = [createLocalWallet(), createLocalWallet()];
    assert.notEqual(await a.getAddress(), await b.getAddress());
  });

  it('addresses are deterministic in the public key', () => {
    const raw = Buffer.alloc(32, 7);
    assert.equal(deriveAddress(raw), deriveAddress(raw));
    assert.match(deriveAddress(raw), /^pndt1[0-9a-f]{40}$/);
  });

  it('settle produces an honestly-labeled sim hash, never mistakable for on-chain', async () => {
    const wallet = createLocalWallet();
    const offer = buildOffer({ resource: '/tip/@v', payTo: 'jar', network: LOCAL_NETWORK, amount: '0.10' }).accepts[0];
    const s = await wallet.settle(offer);
    assert.match(s.txHash, /^sim-[0-9a-f]{40}$/);
    assert.equal(s.network, 'local-sim');
    assert.equal(s.explorerUrl, null);
  });

  it('two settlements of the same offer produce different fingerprints', async () => {
    const wallet = createLocalWallet();
    const offer = buildOffer({ resource: '/tip/@v', payTo: 'jar', network: LOCAL_NETWORK, amount: '0.10' }).accepts[0];
    assert.notEqual((await wallet.settle(offer)).txHash, (await wallet.settle(offer)).txHash);
  });
});

describe('devsigner: signature verification (the tip jar side)', () => {
  const verify = localVerifier();

  it('a genuine signed payment verifies', async () => {
    const wallet = createLocalWallet();
    const payment = await signedPayment(wallet);
    assert.equal(await verify({ payment, bytes: canonicalPaymentBytes(payment) }), true);
  });

  it('a tampered amount fails verification', async () => {
    const wallet = createLocalWallet();
    const payment = await signedPayment(wallet);
    const tampered = { ...payment, amount: '99.00' };
    assert.equal(await verify({ payment: tampered, bytes: canonicalPaymentBytes(tampered) }), false);
  });

  it('a forged from-address fails the address↔pubkey binding', async () => {
    const wallet = createLocalWallet();
    const impostor = createLocalWallet();
    const payment = await signedPayment(wallet, { from: await impostor.getAddress() });
    assert.equal(await verify({ payment, bytes: canonicalPaymentBytes(payment) }), false);
  });

  it("swapping in another wallet's public key fails", async () => {
    const wallet = createLocalWallet();
    const other = createLocalWallet();
    const payment = await signedPayment(wallet, { fromPublicKey: other.publicKeyB64() });
    assert.equal(await verify({ payment, bytes: canonicalPaymentBytes(payment) }), false);
  });

  it('a signature from a different key fails', async () => {
    const wallet = createLocalWallet();
    const other = createLocalWallet();
    const payment = await signedPayment(wallet);
    payment.signature = await other.signBytes(canonicalPaymentBytes(payment));
    assert.equal(await verify({ payment, bytes: canonicalPaymentBytes(payment) }), false);
  });

  it('missing public key or signature fails fast', async () => {
    const wallet = createLocalWallet();
    const payment = await signedPayment(wallet);
    assert.equal(await verify({ payment: { ...payment, fromPublicKey: undefined }, bytes: canonicalPaymentBytes(payment) }), false);
    assert.equal(await verify({ payment: { ...payment, signature: undefined }, bytes: canonicalPaymentBytes(payment) }), false);
  });

  it('garbage base64 in the public key fails without throwing', async () => {
    const wallet = createLocalWallet();
    const payment = await signedPayment(wallet, { fromPublicKey: '!!!' });
    assert.equal(await verify({ payment, bytes: canonicalPaymentBytes(payment) }), false);
  });
});
