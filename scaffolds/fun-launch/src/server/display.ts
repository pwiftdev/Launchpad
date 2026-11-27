// Web reads of the display index. Requests read Postgres only; the indexer keeps it current.
import { database } from './database';
import { getCoin } from './dbc';
import { registeredCoin } from './launchRegistry';
import { expectedGenesis } from './launchConfig';
import { DisplayStore, TOUCH_CHANNEL } from './indexer/store';
import type { Coin } from '@/lib/coin';

let store: { genesis: string; value: DisplayStore } | undefined;

/** Null without a database, e.g. a local preview with only sample coins. */
export function displayStore(): DisplayStore | null {
  if (!process.env.DATABASE_URL) return null;
  const genesis = expectedGenesis();
  if (store?.genesis !== genesis) store = { genesis, value: new DisplayStore(database(), genesis) };
  return store!.value;
}

/** Asks the indexer to read a coin now instead of on its next pass. Best effort. */
export async function touchDisplayIndex(mint: string) {
  if (!process.env.DATABASE_URL) return;
  await database()
    .query('SELECT pg_notify($1,$2)', [TOUCH_CHANNEL, mint])
    .catch(() => {});
}

/** The serving clock: chain time from the indexer heartbeat, or unknown. */
export async function displayClock(store: DisplayStore) {
  const status = await store.status();
  return {
    serverTime: status.chainTime,
    clockStale: status.chainTime === 0,
    stale: status.stale,
    network: status.network,
  };
}

/**
 * A coin for a page or API: the index first. A coin registered seconds ago may not be indexed
 * yet, so registered coins alone are read once from chain while the indexer is asked to catch up.
 * Unregistered addresses never reach the RPC from here.
 */
export async function displayCoin(mint: string) {
  const store = displayStore();
  const indexed = store ? await store.coin(mint) : null;
  if (indexed || !store) return indexed;
  if (!(await registeredCoin(store.genesis, mint))) return null;
  const coin = (await getCoin(mint, { fresh: false }))?.coin ?? null;
  if (coin) void touchDisplayIndex(coin.mint);
  return coin;
}

/**
 * Board reads shared by every request for one second, so a burst of viewers costs one query.
 * A coin pushed on the board stream is read fresh for each change; only the stream's
 * simultaneous readers of that one change share the query.
 */
const SHARED_MS = 1000;
type Shared<T> = { at: number; value?: T; pending?: Promise<T> };
const shared = new Map<string, Shared<unknown>>();
export function sharedRead<T>(key: string, load: () => Promise<T>, ttlMs = SHARED_MS): Promise<T> {
  const entry = (shared.get(key) as Shared<T> | undefined) ?? { at: 0 };
  if (entry.value !== undefined && Date.now() - entry.at < ttlMs)
    return Promise.resolve(entry.value);
  if (entry.pending) return entry.pending;
  if (shared.size > 2000) shared.clear();
  shared.set(key, entry);
  entry.pending = load()
    .then((value) => {
      entry.value = value;
      entry.at = Date.now();
      return value;
    })
    .finally(() => {
      entry.pending = undefined;
    });
  return entry.pending;
}
export const sharedCoins = (store: DisplayStore) =>
  sharedRead(`coins:${store.genesis}`, () => store.coins());
export const sharedClock = (store: DisplayStore) =>
  sharedRead(`clock:${store.genesis}`, () => displayClock(store));
export const sharedCoin = (store: DisplayStore, mint: string) =>
  sharedRead(`coin:${store.genesis}:${mint}`, () => store.coin(mint), 0);
/** Newest trades for a coin page push; every viewer of one change shares the read. */
export const sharedRecentTrades = (store: DisplayStore, coin: Coin) =>
  sharedRead(`recent:${store.genesis}:${coin.mint}`, () => store.trades(coin, PUSHED_TRADES), 0);
const PUSHED_TRADES = 50;
