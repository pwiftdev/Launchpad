import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { Coin } from '@/lib/coin';
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  meta: vi.fn(),
  hash: vi.fn(),
  remoteHash: vi.fn(),
}));
vi.mock('./dbc', () => ({ listCoins: mocks.list, cachedMeta: mocks.meta }));
vi.mock('./imageHash', () => ({ imageHash: mocks.hash, remoteImageHash: mocks.remoteHash }));
import { checkLaunch } from './antivamp';
const testdrop = {
  mint: 'J21qHBjC2mLQbHL9TQhXBxNn52ViwhgXSKL8urbWMxsq',
  name: 'TESTDROP',
  symbol: 'TESTDROP',
  image: 'https://ipfs.io/ipfs/testdrop-image',
  launchedAt: 1,
  isMigrated: false,
} as Coin;
const protectedCoin = {
  ...testdrop,
  mint: 'another-mint',
  name: 'Original',
  symbol: 'ORIGINAL',
  image: 'https://ipfs.io/ipfs/protected-image',
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ pairs: [] }))
  );
  mocks.list.mockResolvedValue([testdrop, protectedCoin]);
  mocks.hash.mockResolvedValue('0000000000000000');
  mocks.remoteHash.mockResolvedValue('ffffffffffffffff');
});
afterEach(() => vi.unstubAllGlobals());
it('permits TESTDROP artwork reuse without comparing it, while still checking other launches', async () => {
  expect(
    await checkLaunch({ name: 'RINSED', symbol: 'RINSED', image: Buffer.from('art') })
  ).toBeNull();
  expect(mocks.remoteHash).not.toHaveBeenCalledWith(testdrop.image);
  expect(mocks.remoteHash).toHaveBeenCalledExactlyOnceWith(protectedCoin.image);
});
it('still rejects matching artwork from another mint', async () => {
  mocks.remoteHash.mockResolvedValue('0000000000000000');
  expect(
    await checkLaunch({ name: 'RINSED', symbol: 'RINSED', image: Buffer.from('art') })
  ).toMatchObject({ field: 'image', error: expect.stringContaining('ORIGINAL') });
});
it('retains TESTDROP ticker and source-post checks despite the artwork exception', async () => {
  mocks.list.mockResolvedValue([{ ...testdrop, launchedAt: Math.floor(Date.now() / 1000) }]);
  expect(
    await checkLaunch({ name: 'RINSED', symbol: 'TESTDROP', image: Buffer.from('art') })
  ).toMatchObject({ field: 'ticker' });
  mocks.meta.mockReturnValue({ source: 'https://x.com/creator/status/12345' });
  expect(
    await checkLaunch({
      name: 'RINSED',
      symbol: 'RINSED',
      sourceUrl: 'https://x.com/creator/status/12345',
      image: Buffer.from('art'),
    })
  ).toMatchObject({ field: 'source' });
});

it('keeps ticker protection when a slot-based launch timestamp is temporarily unavailable', async () => {
  mocks.list.mockResolvedValue([{ ...protectedCoin, launchedAt: 0 }]);
  expect(await checkLaunch({ name: 'Different name', symbol: 'ORIGINAL' })).toMatchObject({
    field: 'ticker',
  });
});
