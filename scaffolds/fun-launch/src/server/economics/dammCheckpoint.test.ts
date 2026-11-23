import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  sealDammCheckpoint,
  verifyDammCheckpoint,
  assertVerifiedDammCheckpoint,
  type UnsignedDammCheckpoint,
} from './dammCheckpoint';
const identity = {
  networkGenesis: 'isolated-genesis',
  programId: 'program',
  mint: 'mint',
  pool: 'pool',
  position: 'position',
  classificationPolicy: 'q128-growth-v1' as const,
};
const body = (): UnsignedDammCheckpoint => ({
  ...identity,
  version: 1,
  cursorSignature: '1'.repeat(64),
  cursorSlot: 100,
  cursorTransactionIndex: 2,
  payload: { counters: { b: '2', a: '1' }, attributions: [{ eventIndex: 3 }] },
  previousCheckpointDigest: null,
  rollingHistoryDigest: 'a'.repeat(64),
  verifiedSnapshotSlot: 101,
  poolDigest: 'b'.repeat(64),
  positionDigest: 'c'.repeat(64),
});
beforeEach(() => {
  vi.stubEnv('FINANCIAL_CHECKPOINT_HMAC_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.stubEnv('FINANCIAL_CHECKPOINT_KEY_ID', 'primary');
  vi.stubEnv('FINANCIAL_CHECKPOINT_VERIFY_KEYS_JSON', '{}');
});
afterEach(() => vi.unstubAllEnvs());
describe('authenticated immutable DAMM replay checkpoints', () => {
  it('survives reordered persisted JSON and deep-freezes a detached verified payload', () => {
    const original = body(),
      sealed = sealDammCheckpoint(original);
    original.payload.counters = { a: 'tampered' };
    expect(sealed.payload.counters).toEqual({ a: '1', b: '2' });
    const reversed = JSON.parse(JSON.stringify(sealed)) as typeof sealed;
    reversed.payload.counters = { a: '1', b: '2' };
    const checked = verifyDammCheckpoint(reversed, identity);
    expect(checked.digest).toBe(sealed.digest);
    expect(Object.isFrozen(checked.payload)).toBe(true);
    expect(Object.isFrozen(checked.payload.counters)).toBe(true);
    expect(() => assertVerifiedDammCheckpoint(checked)).not.toThrow();
  });
  it('rejects payload, cursor, lineage, identity and wrong-key tampering', () => {
    const sealed = sealDammCheckpoint(body());
    for (const altered of [
      { ...sealed, payload: { a: 'changed' } },
      { ...sealed, cursorSlot: 99 },
      { ...sealed, previousCheckpointDigest: 'd'.repeat(64) },
      { ...sealed, pool: 'other' },
    ])
      expect(() => verifyDammCheckpoint(altered, identity)).toThrow();
    vi.stubEnv('FINANCIAL_CHECKPOINT_HMAC_KEY', Buffer.alloc(32, 8).toString('base64'));
    expect(() => verifyDammCheckpoint(sealed, identity)).toThrow('authentication');
  });
  it('rejects missing/weak keys and non-JSON values instead of silently dropping them', () => {
    vi.stubEnv('FINANCIAL_CHECKPOINT_HMAC_KEY', Buffer.alloc(31).toString('base64'));
    expect(() => sealDammCheckpoint(body())).toThrow('at least 32');
    vi.stubEnv('FINANCIAL_CHECKPOINT_HMAC_KEY', Buffer.alloc(32).toString('base64'));
    expect(() => sealDammCheckpoint({ ...body(), payload: { bad: undefined } })).toThrow('JSON');
    expect(() => sealDammCheckpoint({ ...body(), payload: { bad: 1n } })).toThrow('JSON');
    expect(() =>
      assertVerifiedDammCheckpoint(JSON.parse(JSON.stringify(sealDammCheckpoint(body()))))
    ).toThrow('MAC-verified');
  });
  it('retains verification through explicit key rotation and fails if the old key is removed', () => {
    const old = Buffer.alloc(32, 7).toString('base64');
    const sealed = sealDammCheckpoint(body());
    vi.stubEnv('FINANCIAL_CHECKPOINT_KEY_ID', 'next');
    vi.stubEnv('FINANCIAL_CHECKPOINT_HMAC_KEY', Buffer.alloc(32, 9).toString('base64'));
    vi.stubEnv('FINANCIAL_CHECKPOINT_VERIFY_KEYS_JSON', JSON.stringify({ primary: old }));
    expect(verifyDammCheckpoint(sealed, identity).keyId).toBe('primary');
    expect(sealDammCheckpoint(body()).keyId).toBe('next');
    vi.stubEnv('FINANCIAL_CHECKPOINT_VERIFY_KEYS_JSON', '{}');
    expect(() => verifyDammCheckpoint(sealed, identity)).toThrow('retain prior keyring');
  });
  it('redacts malformed verification-keyring contents from validation errors', () => {
    vi.stubEnv('FINANCIAL_CHECKPOINT_VERIFY_KEYS_JSON', '{"old":"do-not-print-this-secret"');
    expect(() => sealDammCheckpoint(body())).toThrow(
      'Invalid checkpoint verification keyring JSON'
    );
    try {
      sealDammCheckpoint(body());
    } catch (error) {
      expect(String(error)).not.toContain('do-not-print');
    }
  });
});
