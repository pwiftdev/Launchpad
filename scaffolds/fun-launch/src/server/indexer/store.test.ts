import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Coin } from '@/lib/coin';
import { DisplayStore, decodeEvent, encodeEvent, type IndexedTrade } from './store';

const genesis = 'display-fixture';
const MINT = 'So11111111111111111111111111111111111111112';
const POOL = '11111111111111111111111111111111';
let db: PGlite, store: DisplayStore;
const notifications: string[] = [];

const coin = (extra: Partial<Coin> = {}): Coin => ({
  mint: MINT,
  pool: POOL,
  creator: 'creator-wallet',
  name: 'Masked Frog',
  symbol: 'MASK',
  image: null,
  launchedAt: 1_000,
  quoteReserveSol: 1,
  thresholdSol: 80,
  progress: 0.01,
  isMigrated: false,
  priceSol: 0.000001,
  marketCapSol: 1000,
  tokenSupply: 1_000_000_000,
  ...extra,
});
const trade = (n: number, extra: Partial<IndexedTrade> = {}): IndexedTrade => ({
  sig: `sig-${n}`,
  instructionIndex: 0,
  eventIndex: 1,
  ts: 1_000 + n,
  side: 'buy',
  wallet: `wallet-${n}`,
  walletRole: 'token-owner',
  sol: 1,
  tokens: 1000,
  feeSol: 0.0125,
  route: 'dbc',
  priceSol: 0.000002,
  marketCapSol: 2000,
  slot: 10 + n,
  pool: POOL,
  ...extra,
});

beforeAll(async () => {
  // Like node-postgres, return bigint columns as strings.
  db = new PGlite({ parsers: { 20: (value: string) => value } });
  await db.waitReady;
  await db.listen('display_index', (payload) => notifications.push(payload));
});
beforeEach(async () => {
  await db.exec('DROP SCHEMA public CASCADE;CREATE SCHEMA public;');
  await db.exec(
    readFileSync(
      new URL('../../../../../scripts/migrations/037-display-index.sql', import.meta.url),
      'utf8'
    )
  );
  await db.exec(
    readFileSync(
      new URL('../../../../../scripts/migrations/044-display-forward-catchup.sql', import.meta.url),
      'utf8'
    )
  );
  store = new DisplayStore(db, genesis);
  notifications.length = 0;
});
afterAll(async () => db.close());
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('display index store', () => {
  it('writes only coins whose display changed and announces them', async () => {
    expect(await store.upsertCoins([coin()])).toEqual([MINT]);
    expect(await store.upsertCoins([coin()])).toEqual([]);
    expect(await store.upsertCoins([coin({ marketCapSol: 2000 })])).toEqual([MINT]);
    await settle();
    expect(notifications).toEqual([`coin:${MINT}`, 'board', `coin:${MINT}`]);
    expect((await store.coins()).map((c) => c.marketCapSol)).toEqual([2000]);
    await store.removeCoinsExcept([]);
    expect(await store.coins()).toEqual([]);
  });

  it('stores each swap once, reads newest first and converts hSOL amounts to SOL', async () => {
    const hsol = coin({ quoteToSol: 1.1 });
    await store.upsertCoins([hsol]);
    expect(await store.insertTrades(MINT, [trade(1), trade(2)])).toBe(2);
    expect(await store.insertTrades(MINT, [trade(2)])).toBe(0);
    await store.saveCursor(POOL, MINT, {
      newest: 'sig-2',
      backfillBefore: null,
      complete: true,
      forwardHead: null,
      forwardBefore: null,
    });
    const { trades, complete } = await store.trades(hsol, 10);
    expect(trades.map((t) => t.id)).toEqual(['sig-2:0:1', 'sig-1:0:1']);
    expect(trades[0]).toMatchObject({ sol: 1.1, priceSol: 0.0000022 });
    expect(trades[0]!.marketCapSol).toBeCloseTo(2200);
    expect(complete).toBe(true);
    expect((await store.trades(hsol, 1)).complete).toBe(false);
  });

  it('reports partial history until every pool of the coin is backfilled', async () => {
    const migrated = coin({ migratedPool: 'Migrated1111111111111111111111111' });
    await store.saveCursor(POOL, MINT, {
      newest: null,
      backfillBefore: null,
      complete: true,
      forwardHead: null,
      forwardBefore: null,
    });
    expect((await store.trades(migrated, 10)).complete).toBe(false);
  });

  it('reads the last actual price in each quarter hour of the past day', async () => {
    await store.insertTrades(MINT, [
      trade(1, { ts: 1, priceSol: 2 }),
      trade(2, { ts: 99_010, priceSol: 3 }),
      trade(3, { ts: 99_030, priceSol: 4 }),
      trade(4, { ts: 99_920, priceSol: 7 }),
      trade(5, { ts: 100_100, priceSol: 10 }),
    ]);
    expect(await store.prices(coin({ quoteToSol: 2 }), 100_000)).toEqual([
      { time: 99_030, priceSol: 8 },
      { time: 99_920, priceSol: 14 },
    ]);
  });

  it('sums every fee but counts launch tax only inside the launch window', async () => {
    const c = coin();
    await store.insertTrades(MINT, [
      trade(1, { feeSol: 0.5 }),
      trade(2, { ts: 1_000_000, feeSol: 0.25 }),
    ]);
    const pot = await store.pot(c);
    expect(pot.feesSol).toBeCloseTo(0.75);
    expect(pot.taxedTrades).toBe(1);
  });

  it('replaces holders as a whole and never lets an older scan overwrite a newer one', async () => {
    const c = coin();
    const scan = (slot: number, holders: [string, bigint][]) => ({
      slot,
      decimals: 6,
      supply: 1_000_000_000_000n,
      excluded: 400_000_000_000n,
      holders: new Map(holders),
    });
    expect(
      await store.replaceHolders(
        MINT,
        scan(20, [
          ['alice', 300_000_000_000n],
          ['creator-wallet', 200_000_000_000n],
          ['zero', 0n],
        ])
      )
    ).toBe(true);
    expect(await store.replaceHolders(MINT, scan(19, [['late', 1n]]))).toBe(false);
    const holders = (await store.holders(c))!;
    expect(holders).toMatchObject({ holderCount: 2, circulating: 600_000, tokenSupply: 1_000_000 });
    expect(holders.holders.map((h) => [h.owner, h.amount, h.isCreator])).toEqual([
      ['alice', 300_000, false],
      ['creator-wallet', 200_000, true],
    ]);
    expect(holders.holders[0]!.shareOfCirculating).toBeCloseTo(0.5);
    expect(await store.holders(c, 1)).toMatchObject({
      holderCount: 2,
      partial: true,
      holders: [holders.holders[0]],
    });
  });

  it('summarizes 24-hour markets and hourly swap counts from indexed trades', async () => {
    const now = 100_000;
    const c = coin({ marketCapSol: 3000 });
    await store.insertTrades(MINT, [
      trade(1, { ts: now - 100 }),
      trade(2, { ts: now - 50, side: 'sell' }),
      trade(3, { ts: now - 90_000 }),
    ]);
    const market = (await store.markets([c], now))[MINT]!;
    expect(market).toMatchObject({ trades: 2, buys: 1, sells: 1 });
    expect((await store.recentSwapCounts(3600, now)).get(MINT)).toBe(2);
  });

  it('serves chain time from a fresh heartbeat and nothing from a missing one', async () => {
    expect(await store.status()).toMatchObject({ stale: true, chainTime: 0 });
    await store.heartbeat({ slot: 5, chainTime: 1_800_000_000, tps: 2500, rpcMs: 40 });
    expect(await store.status()).toMatchObject({
      stale: false,
      chainTime: 1_800_000_000,
      network: { slot: 5, tps: 2500, rpcMs: 40 },
    });
    await db.query("UPDATE display_indexer_status SET heartbeat_at=now()-interval '60 seconds'");
    expect(await store.status()).toMatchObject({ stale: false });
    await db.query("UPDATE display_indexer_status SET heartbeat_at=now()-interval '151 seconds'");
    expect(await store.status()).toMatchObject({ stale: true, chainTime: 0 });
  });
});

describe('display events', () => {
  it('round-trips kinds and refuses anything else', () => {
    for (const event of [{ kind: 'board' }, { kind: 'trades', mint: MINT }] as const)
      expect(decodeEvent(encodeEvent(event))).toEqual(event);
    for (const bad of ['', 'trades:', 'drop:' + MINT, 'coin:not a mint'])
      expect(decodeEvent(bad)).toBeNull();
  });
});
