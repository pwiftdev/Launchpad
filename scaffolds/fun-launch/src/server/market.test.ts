import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { OFFICIAL_MSKD } from '@/constants/officialMskd';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  slot: vi.fn(),
  samples: vi.fn(),
  signatures: vi.fn(),
  txs: vi.fn(),
  decode: vi.fn(),
}));
vi.mock('./dbc', () => ({
  listCoins: mocks.list,
  connection: {
    getSlot: mocks.slot,
    getRecentPerformanceSamples: mocks.samples,
    getSignaturesForAddress: mocks.signatures,
    getTransactions: mocks.txs,
  },
}));
vi.mock('./trades', () => ({
  decodeTrades: (tx: unknown, pool: string, coin: unknown) => [mocks.decode(tx, pool, coin)],
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('MOBULA_API_KEY', '');
  mocks.list.mockResolvedValue(
    Array.from({ length: 12 }, (_, i) => ({
      mint: `coin${i}`,
      pool: new PublicKey(Buffer.alloc(32, i)).toBase58(),
      marketCapSol: 100,
      quoteReserveSol: 1,
      priceSol: 0.00001,
      launchedAt: i,
    }))
  );
  mocks.slot.mockResolvedValue(12345);
  mocks.samples.mockResolvedValue([{ numTransactions: 1200, samplePeriodSecs: 60 }]);
  mocks.signatures.mockResolvedValue([
    { signature: 'test', err: null, blockTime: Math.floor(Date.now() / 1000) - 10 },
  ]);
  mocks.txs.mockImplementation(async (signatures: string[]) =>
    signatures.map((signature) => ({ transaction: { signatures: [signature] } }))
  );
  mocks.decode.mockImplementation(() => ({
    ts: Math.floor(Date.now() / 1000) - 10,
    marketCapSol: 90,
    priceSol: 0.00001,
    sol: 1,
    side: 'buy',
    feeSol: 0.1,
  }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('shared market snapshot', () => {
  it('samples every pool with bounded concurrency and shares overlapping loads', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.signatures.mockImplementation(async () => {
      await waiting;
      return [{ signature: 'test', err: null, blockTime: Math.floor(Date.now() / 1000) - 10 }];
    });
    const { getMarketStats } = await import('./market');
    const requests = Promise.all([getMarketStats(), getMarketStats()]);
    try {
      await vi.waitFor(() => expect(mocks.signatures).toHaveBeenCalledTimes(4));
    } finally {
      release();
    }
    const [first, second] = await requests;
    expect(first).toEqual(second);
    expect(first.trackedPools).toBe(12);
    expect(first.totalPools).toBe(12);
    expect(first.partial).toBe(false);
    expect(first.trades).toBe(12);
    expect(first.network.tps).toBe(20);
    expect(mocks.signatures).toHaveBeenCalledTimes(12);
    expect(mocks.signatures.mock.calls.every((call) => call[1].limit === 24)).toBe(true);
    await getMarketStats();
    expect(mocks.signatures).toHaveBeenCalledTimes(12);
  });
  it('reads the official MSKD graduated pool first and includes all older launches', async () => {
    vi.stubEnv('NEXT_PUBLIC_NETWORK', 'mainnet-beta');
    const coins = await mocks.list();
    const migratedPool = new PublicKey(Buffer.alloc(32, 99)).toBase58();
    Object.assign(coins[0], { mint: OFFICIAL_MSKD.mint, isMigrated: true, migratedPool });
    Object.assign(coins[1], { symbol: 'MSKD' });
    const { getMarketStats } = await import('./market');
    const data = await getMarketStats();
    expect(Object.keys(data.tokens).sort()).toEqual(
      coins.map((coin: { mint: string }) => coin.mint).sort()
    );
    expect(data.tokens[OFFICIAL_MSKD.mint]).toMatchObject({
      points: [10_000, 100],
      trades: 1,
      partial: true,
    });
    expect(mocks.signatures.mock.calls[0]?.[0].toBase58()).toBe(migratedPool);
    expect(mocks.signatures).toHaveBeenCalledTimes(12);
  });
  it('does not invent missing network samples or pool histories', async () => {
    mocks.samples.mockResolvedValue([]);
    mocks.signatures.mockRejectedValue(new Error('Provider unavailable'));
    const { getMarketStats } = await import('./market');
    const data = await getMarketStats();
    expect(data.network.tps).toBeNull();
    expect(data.network.slot).toBe(12345);
    expect(data.trackedPools).toBe(0);
    expect(data.tokens).toEqual({});
    expect(data.partial).toBe(true);
  });
  it('does not re-download transactions still present in the same signature sample', async () => {
    let time = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => time);
    const { getMarketStats } = await import('./market');
    expect((await getMarketStats()).trackedPools).toBe(12);
    expect(mocks.txs).toHaveBeenCalledTimes(12);
    time += 61_000;
    await getMarketStats();
    await vi.waitFor(async () => {
      expect((await getMarketStats()).updatedAt).toBe(Math.floor(time / 1000));
    });
    expect(mocks.signatures).toHaveBeenCalledTimes(24);
    expect(mocks.txs).toHaveBeenCalledTimes(12);
  });
  it('keeps quiet pools in coverage and resamples them when reserves move or the cache expires', async () => {
    let time = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => time);
    const coins = (await mocks.list()).slice(0, 2);
    mocks.list.mockResolvedValue(coins);
    mocks.signatures.mockResolvedValue([]);
    const { getMarketStats } = await import('./market');
    const refresh = async (seconds: number) => {
      time += seconds * 1000;
      await getMarketStats();
      await vi.waitFor(async () => {
        expect((await getMarketStats()).updatedAt).toBe(Math.floor(time / 1000));
      });
      return getMarketStats();
    };

    expect(await getMarketStats()).toMatchObject({ trackedPools: 2, trades: 0 });
    expect(await refresh(61)).toMatchObject({ trackedPools: 2, trades: 0 });
    expect(mocks.signatures).toHaveBeenCalledTimes(2);

    coins[0].quoteReserveSol++;
    mocks.signatures.mockResolvedValueOnce([
      { signature: 'new', err: null, blockTime: Math.floor(time / 1000) },
    ]);
    expect(await refresh(61)).toMatchObject({ trackedPools: 2, trades: 1 });
    expect(mocks.signatures).toHaveBeenCalledTimes(3);
    expect(mocks.signatures.mock.lastCall?.[0].toBase58()).toBe(coins[0].pool);

    expect(await refresh(180)).toMatchObject({ trackedPools: 2 });
    expect(mocks.signatures).toHaveBeenCalledTimes(5);
  });
  it('starts Mobula reads together and uses RPC for pools missing indexed data', async () => {
    const { QUOTES } = await import('@/lib/feeModes');
    const coin = {
      mint: 'covered',
      pool: PublicKey.default.toBase58(),
      tokenSupply: 100,
      marketCapSol: 10,
      quoteMint: QUOTES.sol.mint,
      launchedAt: 1,
    };
    const slowPool = new PublicKey(Buffer.alloc(32, 3)).toBase58();
    const laterPool = new PublicKey(Buffer.alloc(32, 4)).toBase58();
    mocks.list.mockResolvedValue([
      coin,
      { ...coin, mint: 'uncovered', pool: new PublicKey(Buffer.alloc(32, 1)).toBase58() },
      { ...coin, mint: 'quiet', pool: new PublicKey(Buffer.alloc(32, 2)).toBase58() },
      { ...coin, mint: 'slow', pool: slowPool },
      { ...coin, mint: 'later', pool: laterPool },
    ]);
    vi.stubEnv('NEXT_PUBLIC_NETWORK', 'mainnet-beta');
    vi.stubEnv('MOBULA_API_KEY', 'test-key');
    let finishResponses!: () => void;
    const providerBarrier = new Promise<void>((resolve) => {
      finishResponses = resolve;
    });
    const fetchSample = vi.fn(async (url: URL) => {
      await providerBarrier;
      const pool = url.searchParams.get('address');
      if (pool === slowPool) throw new DOMException('Timed out', 'TimeoutError');
      return Response.json({
        data:
          pool === coin.pool || pool === laterPool
            ? [
                {
                  id: '1',
                  blockchain: 'Solana',
                  marketAddress: pool,
                  type: 'buy',
                  date: Date.now() - 1000,
                  baseToken: { address: pool === laterPool ? 'later' : coin.mint },
                  quoteToken: { address: QUOTES.sol.mint },
                  baseTokenAmount: 2,
                  quoteTokenAmount: 1,
                },
              ]
            : [],
      });
    });
    vi.stubGlobal('fetch', fetchSample);
    const { getMarketStats } = await import('./market');
    const pending = getMarketStats();
    try {
      await vi.waitFor(() => expect(fetchSample).toHaveBeenCalledTimes(4));
      expect(mocks.signatures).not.toHaveBeenCalled();
    } finally {
      finishResponses();
    }
    const data = await pending;
    expect(data.tokens.covered).toMatchObject({ volumeSol: 1, trades: 1, partial: true });
    expect(data.tokens.later).toMatchObject({ volumeSol: 1, trades: 1, partial: true });
    expect(data.trackedPools).toBe(5);
    expect(fetchSample).toHaveBeenCalledTimes(5);
    expect(mocks.signatures).toHaveBeenCalledTimes(3);
    expect(mocks.txs).toHaveBeenCalledTimes(3);
  });
});
