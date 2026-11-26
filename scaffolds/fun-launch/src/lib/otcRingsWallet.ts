import { initializePoseidon, ShieldedKeypair, SigningKey } from '@heliuslabs/spr';
import { bytes32 } from '@heliuslabs/spr/keypair';
import {
  getPublicKeyFromAddress,
  signatureBytes,
  verifySignature,
  type Address,
} from '@solana/kit';

export async function unlockRingsDealWallet(input: {
  origin: string;
  genesis: string;
  offerId: string;
  wallet: Address;
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
  expectedDealWallet?: Address;
}) {
  const { origin, genesis, offerId, wallet, signMessage, expectedDealWallet } = input;
  const site = new URL(origin);
  const loopback = site.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(site.hostname);
  if (
    origin !== site.origin ||
    (site.protocol !== 'https:' && !loopback) ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(genesis) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(offerId)
  ) {
    throw new Error('The Rings deal identity is invalid.');
  }
  await initializePoseidon();
  const message = new TextEncoder().encode(
    [
      'MSKD.fun · Unlock OTC deal wallet (v1)',
      `Site ${origin}`,
      `Network ${genesis}`,
      `Offer ${offerId}`,
      `Wallet ${wallet}`,
      'This signature unlocks your private deal wallet on this device. Keep it private.',
    ].join('\n')
  );
  const signature = new Uint8Array(await signMessage(message));
  try {
    if (
      !(await verifySignature(
        await getPublicKeyFromAddress(wallet),
        signatureBytes(signature),
        message
      ))
    ) {
      throw new Error('The connected wallet could not unlock this deal.');
    }
    const seed = new Uint8Array(await crypto.subtle.digest('SHA-256', signature));
    let dealWallet: ShieldedKeypair;
    try {
      dealWallet = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(bytes32(seed)));
    } finally {
      seed.fill(0);
    }
    if (expectedDealWallet && dealWallet.shieldedAddress().solanaAddress() !== expectedDealWallet) {
      dealWallet.destroy();
      throw new Error('The wallet signature did not restore the saved deal wallet.');
    }
    return dealWallet;
  } finally {
    signature.fill(0);
  }
}
