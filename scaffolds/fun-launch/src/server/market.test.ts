import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';

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
  it('caps RPC work, shares concurrent loads and labels limited pool coverage', async () => {
    const { getMarketStats } = await import('./market');
    const [first, second] = await Promise.all([getMarketStats(), getMarketStats()]);
    expect(first).toEqual(second);
    expect(first.trackedPools).toBe(8);
    expect(first.totalPools).toBe(12);
    expect(first.partial).toBe(true);
    expect(first.network.tps).toBe(20);
    expect(mocks.signatures).toHaveBeenCalledTimes(8);
    expect(mocks.signatures.mock.calls.every((call) => call[1].limit === 24)).toBe(true);
    await getMarketStats();
    expect(mocks.signatures).toHaveBeenCalledTimes(8);
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
    expect((await getMarketStats()).trackedPools).toBe(8);
    expect(mocks.txs).toHaveBeenCalledTimes(8);
    time += 61_000;
    await getMarketStats();
    await vi.waitFor(async () => {
      expect((await getMarketStats()).updatedAt).toBe(Math.floor(time / 1000));
    });
    expect(mocks.signatures).toHaveBeenCalledTimes(16);
    expect(mocks.txs).toHaveBeenCalledTimes(8);
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
    mocks.list.mockResolvedValue([
      coin,
      { ...coin, mint: 'uncovered', pool: new PublicKey(Buffer.alloc(32, 1)).toBase58() },
      { ...coin, mint: 'quiet', pool: new PublicKey(Buffer.alloc(32, 2)).toBase58() },
    ]);
    vi.stubEnv('NEXT_PUBLIC_NETWORK', 'mainnet-beta');
    vi.stubEnv('MOBULA_API_KEY', 'test-key');
    let finishResponses!: () => void;
    const providerBarrier = new Promise<void>((resolve) => {
      finishResponses = resolve;
    });
    const fetchSample = vi.fn(async (url: URL) => {
      await providerBarrier;
      return Response.json({
        data:
          url.searchParams.get('address') === coin.pool
            ? [
                {
                  id: '1',
                  blockchain: 'Solana',
                  marketAddress: coin.pool,
                  type: 'buy',
                  date: Date.now() - 1000,
                  baseToken: { address: coin.mint },
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
      await vi.waitFor(() => expect(fetchSample).toHaveBeenCalledTimes(3));
      expect(mocks.signatures).not.toHaveBeenCalled();
    } finally {
      finishResponses();
    }
    const data = await pending;
    expect(data.tokens.covered).toMatchObject({ volumeSol: 1, trades: 1, partial: true });
    expect(data.trackedPools).toBe(3);
    expect(mocks.signatures).toHaveBeenCalledTimes(2);
    expect(mocks.txs).toHaveBeenCalledTimes(2);
  });
});
