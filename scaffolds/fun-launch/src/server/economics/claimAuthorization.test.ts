import { generateKeyPairSync, sign } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { describe, it, expect } from 'vitest';
import { claimAuthorizationMessage, type ClaimAuthorization } from '@/lib/rewards';
import { verifyClaimAuthorization } from './claimAuthorization';

describe('reward preparation authorization', () => {
  const keys = generateKeyPairSync('ed25519');
  const wallet = new PublicKey(
    keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  ).toBase58();
  const input: ClaimAuthorization = {
    networkGenesis: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    wallet,
    mint: new PublicKey(new Uint8Array(32).fill(7)).toBase58(),
    epoch: '123',
    amount: '100000',
    requestId: '12345678-1234-4234-9234-123456789abc',
    issuedAt: 1_000_000,
  };
  const origin = 'https://launch.example';
  const signature = sign(
    null,
    Buffer.from(claimAuthorizationMessage(origin, input)),
    keys.privateKey
  ).toString('base64');
  it('accepts only the exact domain-bound wallet intent', () => {
    expect(verifyClaimAuthorization(input, origin, signature, 1_000_000)).toBe(true);
    for (const changed of [
      { ...input, networkGenesis: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' },
      { ...input, amount: '100001' },
      { ...input, epoch: '124' },
      { ...input, requestId: '12345678-1234-4234-9234-123456789abd' },
      { ...input, wallet: new PublicKey(new Uint8Array(32).fill(8)).toBase58() },
      { ...input, mint: new PublicKey(new Uint8Array(32).fill(9)).toBase58() },
    ])
      expect(verifyClaimAuthorization(changed, origin, signature, 1_000_000)).toBe(false);
    expect(verifyClaimAuthorization(input, 'https://attacker.example', signature, 1_000_000)).toBe(
      false
    );
  });
  it('rejects alternate base64 spellings of the same signature bytes', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const index = alphabet.indexOf(signature[85]!);
    const alias = signature.slice(0, 85) + alphabet[index + 1] + '==';
    expect(Buffer.from(alias, 'base64')).toEqual(Buffer.from(signature, 'base64'));
    expect(verifyClaimAuthorization(input, origin, alias, 1_000_000)).toBe(false);
  });
  it('rejects expired, future, malformed and unsigned requests', () => {
    expect(verifyClaimAuthorization(input, origin, signature, 1_300_001)).toBe(false);
    expect(verifyClaimAuthorization(input, origin, signature, 969_999)).toBe(false);
    expect(verifyClaimAuthorization(input, origin, 'invalid', 1_000_000)).toBe(false);
    expect(
      verifyClaimAuthorization({ ...input, wallet: 'invalid' }, origin, signature, 1_000_000)
    ).toBe(false);
  });
});
