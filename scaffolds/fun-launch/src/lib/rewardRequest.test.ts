import { expect, it } from 'vitest';
import {
  clearRewardRequest,
  clearUnrecordedRewardRequest,
  readRewardRequest,
  saveRewardRequest,
  requestRewardPayout,
  type RewardRequestReceipt,
} from './rewardRequest';
import type { RewardsView } from './rewards';
const receipt: RewardRequestReceipt = {
  version: 1,
  networkGenesis: 'network',
  mint: 'mint',
  wallet: 'wallet',
  epoch: '123',
  amount: '500',
  requestId: '12345678-1234-4234-9234-123456789abc',
  issuedAt: 1000,
};
function storage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}
it('persists only a public, scoped receipt and preserves it across reload or a lost request response', () => {
  const db = storage();
  saveRewardRequest(db, {
    ...receipt,
    ...{ signature: 'do-not-store', transaction: 'do-not-store' },
  });
  expect(readRewardRequest(db, receipt)).toEqual(receipt);
  expect([...db.map.values()][0]).not.toContain('do-not-store');
  expect(readRewardRequest(db, { ...receipt, wallet: 'someone-else' })).toBeNull();
  expect(readRewardRequest(db, { ...receipt, networkGenesis: 'other-bank' })).toBeNull();
});
it('clears only an expired unrecorded local receipt after a fresh same-network ready response', () => {
  const db = storage();
  saveRewardRequest(db, receipt);
  const fresh: RewardsView = {
    networkGenesis: receipt.networkGenesis,
    status: 'ready' as const,
    mode: 'community' as const,
    availableLamports: '500',
    epochs: [],
    request: null,
    creatorJob: null,
  };
  expect(() =>
    clearUnrecordedRewardRequest(db, receipt, fresh, receipt.issuedAt + 330000)
  ).toThrow();
  expect(() =>
    clearUnrecordedRewardRequest(
      db,
      receipt,
      { ...fresh, networkGenesis: 'other' },
      receipt.issuedAt + 330001
    )
  ).toThrow();
  expect(() =>
    clearUnrecordedRewardRequest(
      db,
      receipt,
      { ...fresh, creatorJob: { id: 'pending', signature: null } },
      receipt.issuedAt + 330001
    )
  ).toThrow();
  expect(readRewardRequest(db, receipt)).toEqual(receipt);
  clearUnrecordedRewardRequest(db, receipt, fresh, receipt.issuedAt + 330001);
  expect(readRewardRequest(db, receipt)).toBeNull();
});
it('saves before the first payout POST and recovers its public request after a lost response', async () => {
  const db = storage();
  let posts = 0;
  await expect(
    requestRewardPayout({
      input: receipt,
      origin: 'https://launch.example',
      storage: db,
      signMessage: async (message) => {
        expect(new TextDecoder().decode(message)).toContain('No transaction signature');
        return new Uint8Array(64).fill(1);
      },
      submit: async (body) => {
        posts++;
        expect(readRewardRequest(db, receipt)).toEqual(receipt);
        expect(body).toMatchObject({
          action: 'prepare',
          requestId: receipt.requestId,
          wallet: receipt.wallet,
        });
        throw new Error('Relay response lost');
      },
    })
  ).rejects.toThrow('Relay response lost');
  expect(posts).toBe(1);
  expect(readRewardRequest(db, receipt)).toEqual(receipt);
});
it('never posts when public receipt storage is unavailable', async () => {
  const db = storage();
  let posts = 0;
  await expect(
    requestRewardPayout({
      input: receipt,
      origin: 'https://launch.example',
      storage: {
        ...db,
        setItem: () => {
          throw Error('Storage full');
        },
      },
      signMessage: async () => new Uint8Array(64),
      submit: async () => {
        posts++;
        throw Error('Must not post');
      },
    })
  ).rejects.toThrow('Storage full');
  expect(posts).toBe(0);
});
it('does not erase a newer request when an older request finishes', () => {
  const db = storage(),
    next = { ...receipt, requestId: '12345678-1234-4234-9234-123456789abd' };
  saveRewardRequest(db, next);
  clearRewardRequest(db, receipt);
  expect(readRewardRequest(db, next)).toEqual(next);
  clearRewardRequest(db, next);
  expect(readRewardRequest(db, next)).toBeNull();
});
it('fails before posting when receipt storage fails and rejects malformed receipt amounts', () => {
  const db = storage();
  expect(() =>
    saveRewardRequest(
      {
        ...db,
        setItem: () => {
          throw Error('Storage full');
        },
      },
      receipt
    )
  ).toThrow('Storage full');
  expect(() => saveRewardRequest(db, { ...receipt, amount: '18446744073709551616' })).toThrow();
  saveRewardRequest(db, receipt);
  const key = [...db.map.keys()][0]!;
  db.map.set(key, JSON.stringify({ ...receipt, epoch: 123 }));
  expect(readRewardRequest(db, receipt)).toBeNull();
});
