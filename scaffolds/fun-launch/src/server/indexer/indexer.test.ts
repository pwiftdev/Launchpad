import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Coin } from '@/lib/coin';
import { Keypair } from '@solana/web3.js';
import type { DisplayStore } from './store';

const scans = vi.hoisted(() => ({ pool: vi.fn(), holders: vi.fn() }));
vi.mock('./scan', () => ({ scanPool: scans.pool }));
vi.mock('./holders', () => ({ scanHolders: scans.holders }));
import { DisplayIndexer } from './indexer';

const A = 'So11111111111111111111111111111111111111112';
const B = 'SysvarC1ock11111111111111111111111111111111';
/** Real addresses, because pool subscriptions parse them. */
const addresses = new Map<string, string>();
const address = (label: string) => {
  if (!addresses.has(label)) addresses.set(label, Keypair.generate().publicKey.toBase58());
  return addresses.get(label)!;
};
const coin = (mint: string, extra: Partial<Coin> = {}) =>
  ({ mint, pool: address(`pool-${mint}`), marketCapSol: 1, ...extra }) as Coin;

function fixture(coins: Coin[]) {
  const changes = new Map<string, () => void>();
  let nextId = 0;
  const rpc = {
    onAccountChange: vi.fn((key: { toBase58(): string }, callback: () => void) => {
      changes.set(key.toBase58(), callback);
      return nextId++;
    }),
    removeAccountChangeListener: vi.fn(async () => {}),
    getSlot: vi.fn(async () => 50),
    getBlockTime: vi.fn(async () => 1_800_000_000),
    getRecentPerformanceSamples: vi.fn(async () => [
      { numTransactions: 600, samplePeriodSecs: 60 },
    ]),
  };
  const store = {
    upsertCoins: vi.fn(async (list: Coin[]) => list.map((c) => c.mint)),
    removeCoinsExcept: vi.fn(async () => {}),
    replaceHolders: vi.fn(async () => true),
    heartbeat: vi.fn(async () => {}),
  };
  const deps = {
    rpc: rpc as never,
    store: store as unknown as DisplayStore,
    listCoins: vi.fn(async () => coins),
    loadCoin: vi.fn(async (mint: string) => coins.find((c) => c.mint === mint) ?? null),
    holderExclusions: vi.fn(async () => ['vault']),
    log: () => {},
  };
  return { indexer: new DisplayIndexer(deps), deps, rpc, store, changes };
}

beforeEach(() => {
  scans.pool.mockReset().mockResolvedValue({ inserted: 0, more: false });
  scans.holders.mockReset().mockResolvedValue({ slot: 1, holders: new Map() });
});

describe('display indexer', () => {
  it('watches every pool, and a pool change refreshes only that coin', async () => {
    const f = fixture([coin(A), coin(B, { migratedPool: address(`damm-${B}`) })]);
    await f.indexer.discover();
    expect([...f.changes.keys()].sort()).toEqual(
      [address(`damm-${B}`), address(`pool-${A}`), address(`pool-${B}`)].sort()
    );
    await f.indexer.processDirty();
    expect(scans.pool).toHaveBeenCalledTimes(3);
    scans.pool.mockClear();
    f.changes.get(address(`damm-${B}`))!();
    await f.indexer.processDirty();
    expect(f.deps.loadCoin).toHaveBeenLastCalledWith(B);
    expect(scans.pool.mock.calls.map(([args]) => args.pool)).toEqual([
      address(`pool-${B}`),
      address(`damm-${B}`),
    ]);
    await f.indexer.processDirty();
    expect(scans.pool).toHaveBeenCalledTimes(2);
  });

  it('keeps a pool dirty while it has more history to read', async () => {
    const f = fixture([coin(A)]);
    await f.indexer.discover();
    scans.pool.mockResolvedValueOnce({ inserted: 400, more: true });
    await f.indexer.processDirty();
    await f.indexer.processDirty();
    expect(scans.pool).toHaveBeenCalledTimes(2);
  });

  it('backs off a failing coin instead of retrying it every pass', async () => {
    const f = fixture([coin(A)]);
    await f.indexer.discover();
    scans.pool.mockRejectedValueOnce(new Error('rpc down'));
    await f.indexer.processDirty();
    await f.indexer.processDirty();
    expect(scans.pool).toHaveBeenCalledTimes(1);
  });

  it('scans holders at start and again shortly after trades, a couple of coins at a time', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture([coin(A), coin(B), coin('Stake11111111111111111111111111111111111111')]);
      await f.indexer.discover();
      await f.indexer.processDirty();
      await f.indexer.processHolders();
      expect(scans.holders).toHaveBeenCalledTimes(2);
      await f.indexer.processHolders();
      expect(scans.holders).toHaveBeenCalledTimes(3);
      scans.pool.mockResolvedValue({ inserted: 1, more: false });
      f.indexer.touch(A);
      await f.indexer.processDirty();
      await f.indexer.processHolders();
      expect(scans.holders).toHaveBeenCalledTimes(3);
      vi.advanceTimersByTime(16_000);
      await f.indexer.processHolders();
      expect(scans.holders).toHaveBeenCalledTimes(4);
      expect(f.store.replaceHolders).toHaveBeenLastCalledWith(A, expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops subscriptions for coins that leave the board', async () => {
    const coins = [coin(A), coin(B)];
    const f = fixture(coins);
    await f.indexer.discover();
    coins.pop();
    await f.indexer.discover();
    expect(f.rpc.removeAccountChangeListener).toHaveBeenCalledTimes(1);
    expect(f.store.removeCoinsExcept).toHaveBeenLastCalledWith([A]);
  });

  it('records the chain clock and network rate in its heartbeat', async () => {
    const f = fixture([]);
    await f.indexer.heartbeat();
    expect(f.store.heartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ slot: 50, chainTime: 1_800_000_000, tps: 10 })
    );
  });
});
