import { SigningKey } from '@heliuslabs/spr';
import { getAddressDecoder } from '@solana/kit';
import { expect, it } from 'vitest';
import { unlockRingsDealWallet } from './otcRingsWallet';

it('restores a deal wallet with the original browser signature and separates deals and networks', async () => {
  const signer = SigningKey.generate();
  const context = {
    origin: 'https://mskd.fun',
    genesis: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    offerId: 'eeb96177-6e20-48b4-bac2-e854223b15d0',
    wallet: getAddressDecoder().decode(signer.publicKey().ed25519()),
    signMessage: async (message: Uint8Array) => signer.sign(message),
  };
  const original = await unlockRingsDealWallet(context);
  const expectedDealWallet = original.shieldedAddress().solanaAddress();
  original.destroy();

  const restored = await unlockRingsDealWallet({ ...context, expectedDealWallet });
  try {
    expect(restored.shieldedAddress().solanaAddress()).toBe(expectedDealWallet);
    await expect(
      unlockRingsDealWallet({
        ...context,
        expectedDealWallet,
        offerId: '45bb6248-f539-4457-9670-9aedfde3f02f',
      })
    ).rejects.toThrow('restore the saved deal wallet');
    await expect(
      unlockRingsDealWallet({
        ...context,
        expectedDealWallet,
        genesis: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
      })
    ).rejects.toThrow('restore the saved deal wallet');
    await expect(
      unlockRingsDealWallet({
        ...context,
        signMessage: async () => signer.sign(new Uint8Array([1])),
      })
    ).rejects.toThrow('could not unlock this deal');
  } finally {
    restored.destroy();
    signer.destroy();
  }
});
