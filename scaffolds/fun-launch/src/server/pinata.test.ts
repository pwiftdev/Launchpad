import { afterEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { uploadPublicArtifact } from './pinata';

afterEach(() => vi.unstubAllGlobals());
const identity = {
  mint: Keypair.generate().publicKey.toBase58(),
  genesis: Keypair.generate().publicKey.toBase58(),
  configKey: Keypair.generate().publicKey.toBase58(),
};
const receipt = { cid: `b${'a'.repeat(58)}`, id: '01919976-955f-7d06-bd59-72e80743fb95' };
describe('recoverable public upload receipts', () => {
  it('tags every uploaded artifact with its actual chain/mint/config/purpose', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: receipt })));
    vi.stubGlobal('fetch', fetcher);
    await expect(
      uploadPublicArtifact({
        ...identity,
        buffer: Buffer.from('image'),
        contentType: 'image/png',
        fileName: 'token.png',
        purpose: 'image',
        jwt: 'test-only',
      })
    ).resolves.toEqual(receipt);
    const request = fetcher.mock.calls[0]![1] as RequestInit,
      form = request.body as FormData;
    expect(JSON.parse(String(form.get('keyvalues')))).toEqual({
      rinsed_app: 'launchpad-v1',
      rinsed_mint: identity.mint,
      rinsed_genesis: identity.genesis,
      rinsed_config: identity.configKey,
      rinsed_purpose: 'image',
    });
    expect(form.get('network')).toBe('public');
  });
  it('rejects malformed provider IDs/CIDs instead of storing an untraceable gateway URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ data: { ...receipt, cid: '../other' } })))
    );
    await expect(
      uploadPublicArtifact({
        ...identity,
        buffer: Buffer.from('{}'),
        contentType: 'application/json',
        fileName: 'token.json',
        purpose: 'metadata',
        jwt: 'test-only',
      })
    ).rejects.toThrow('receipt');
  });
});
