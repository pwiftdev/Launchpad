import { generateKeyPairSync, sign } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { launchMessage, type LaunchPayload } from '@/lib/launchAuth';
import { verifyLaunch } from './launchAuth';

const origin = 'https://launch.example';
function request(extra: Partial<LaunchPayload> = {}) {
  const keys = generateKeyPairSync('ed25519');
  const wallet = new PublicKey(
    keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
  );
  const payload: LaunchPayload = {
    tokenLogo: 'data:image/png;base64,eA==',
    tokenName: 'Test',
    tokenSymbol: 'TEST',
    userWallet: wallet.toBase58(),
    mint: PublicKey.default.toBase58(),
    devBuyPercent: 0,
    burnShare: 0,
    ...extra,
  };
  const issuedAt = Date.now();
  const signature = async () =>
    sign(
      null,
      Buffer.from(await launchMessage(payload, origin, issuedAt)),
      keys.privateKey
    ).toString('base64');
  return { payload, issuedAt, signature };
}

describe('launch authorization', () => {
  it('accepts the wallet signature once and rejects replay', async () => {
    const r = request();
    const signature = await r.signature();
    expect(await verifyLaunch(r.payload, origin, r.issuedAt, signature)).toBe(true);
    expect(await verifyLaunch(r.payload, origin, r.issuedAt, signature)).toBe(false);
  });

  it('rejects tampering with every upload field', async () => {
    const r = request();
    const signature = await r.signature();
    for (const [field, value] of Object.entries({
      tokenLogo: 'other',
      tokenName: 'other',
      tokenSymbol: 'OTHER',
      mint: r.payload.userWallet,
      userWallet: r.payload.mint,
      devBuyPercent: 1,
      sourceUrl: 'https://x.com/a/status/12345',
      description: 'Changed the signed story',
      socials: { website: 'https://phish.example' },
      burnShare: 100,
    })) {
      expect(
        await verifyLaunch({ ...r.payload, [field]: value }, origin, r.issuedAt, signature)
      ).toBe(false);
    }
  });

  it('rejects a different origin, expired signatures, and malformed signatures', async () => {
    const r = request();
    const signature = await r.signature();
    expect(await verifyLaunch(r.payload, 'https://attacker.example', r.issuedAt, signature)).toBe(
      false
    );
    expect(await verifyLaunch(r.payload, origin, r.issuedAt - 600_000, signature)).toBe(false);
    expect(await verifyLaunch(r.payload, origin, r.issuedAt + 600_000, signature)).toBe(false);
    expect(await verifyLaunch(r.payload, origin, r.issuedAt, 'bad')).toBe(false);
  });

  it('signs the Masked creator share and states it in the message the wallet shows', async () => {
    const masked = {
      mode: 'masked' as const,
      configKey: PublicKey.default.toBase58(),
      creatorShareBps: 3000,
    };
    const r = request(masked);
    const message = await launchMessage(r.payload, origin, r.issuedAt);
    expect(message).toContain('Launch mode: Masked');
    expect(message).toContain('creator 30%, holders 70%. Locked forever.');
    const signature = await r.signature();
    for (const creatorShareBps of [0, 7000, 10_000])
      expect(
        await verifyLaunch({ ...r.payload, creatorShareBps }, origin, r.issuedAt, signature)
      ).toBe(false);
    expect(await verifyLaunch(r.payload, origin, r.issuedAt, signature)).toBe(true);
    await expect(
      launchMessage({ ...r.payload, creatorShareBps: undefined }, origin, r.issuedAt)
    ).rejects.toThrow('creator share');
  });
});
