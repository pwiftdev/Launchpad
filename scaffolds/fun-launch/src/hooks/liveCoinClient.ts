import type { QueryClient } from '@tanstack/react-query';
import type { Coin, Trade, TradesResponse } from '@/lib/coin';
type Source = Pick<EventSource, 'addEventListener' | 'close'> & {
  onerror: ((event: Event) => unknown) | null;
};
export type LiveCoinEnvironment = {
  document: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>;
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  navigator: Pick<Navigator, 'onLine'>;
  createSource: (url: string) => Source;
};
type Stream = {
  source: Source;
  users: number;
  connected: boolean;
  listeners: Set<(connected: boolean) => void>;
  clients: Map<QueryClient, number>;
  timer?: ReturnType<typeof setTimeout>;
};
const streams = new Map<string, Stream>(),
  boardTimes = new WeakMap<QueryClient, number>();
export function invalidateCoinQueries(client: QueryClient, mint: string, includeHolders = true) {
  for (const queryKey of [
    ['coin', mint],
    ['trades', mint],
    ...(includeHolders ? [['holders', mint]] : []),
  ])
    void client.invalidateQueries({ queryKey });
  if (Date.now() - (boardTimes.get(client) ?? -Infinity) > 8000) {
    boardTimes.set(client, Date.now());
    for (const queryKey of [['coins'], ['market-stats'], ['trending']])
      void client.invalidateQueries({ queryKey });
  }
}
/** Shared browser transport. Hidden/offline tabs hold no SSE connection and schedule no updates. */
export function watchLiveCoin(
  client: QueryClient,
  mint: string,
  onStatus: (connected: boolean) => void,
  env: LiveCoinEnvironment
) {
  let attached: Stream | undefined;
  const disconnect = (notify: boolean) => {
    const entry = attached;
    if (!entry) return;
    attached = undefined;
    entry.listeners.delete(onStatus);
    const users = entry.clients.get(client) ?? 1;
    if (users === 1) entry.clients.delete(client);
    else entry.clients.set(client, users - 1);
    if (--entry.users === 0) {
      entry.source.close();
      if (entry.timer) clearTimeout(entry.timer);
      streams.delete(mint);
    }
    if (notify) onStatus(false);
  };
  const availability = () => {
    if (env.document.hidden || env.navigator.onLine === false) {
      disconnect(true);
      return;
    }
    if (attached) return;
    let entry = streams.get(mint);
    if (!entry) {
      const source = env.createSource(`/api/coins/${encodeURIComponent(mint)}/live`),
        created: Stream = {
          source,
          users: 0,
          connected: false,
          listeners: new Set(),
          clients: new Map(),
        };
      entry = created;
      streams.set(mint, entry);
      const status = (value: boolean) => {
          created.connected = value;
          for (const listener of created.listeners) listener(value);
        },
        invalidate = (holders: boolean) => {
          for (const activeClient of created.clients.keys())
            invalidateCoinQueries(activeClient, mint, holders);
        };
      // Updates carry the changed coin and its newest trades, so viewers apply them without a
      // request. Only a new holder scan, or an update the page cannot apply, triggers a refetch.
      source.addEventListener('ready', () => {
        if (!created.users) return;
        status(true);
        invalidate(true);
      });
      let holders = false;
      source.addEventListener('update', (event?: Event) => {
        if (!created.users) return;
        const update = parseUpdate(event);
        let applied = true;
        for (const activeClient of created.clients.keys())
          applied = applyUpdate(activeClient, mint, update) && applied;
        if (applied) return;
        // Bursts of updates the page cannot apply collapse into one refetch.
        if (update?.kind === 'holders') holders = true;
        if (created.timer) return;
        created.timer = setTimeout(() => {
          created.timer = undefined;
          if (!created.users) return;
          const withHolders = holders;
          holders = false;
          invalidate(withHolders);
        }, 350);
      });
      source.onerror = () => status(false);
    }
    entry.users++;
    entry.clients.set(client, (entry.clients.get(client) ?? 0) + 1);
    entry.listeners.add(onStatus);
    attached = entry;
    onStatus(entry.connected);
  };
  env.document.addEventListener('visibilitychange', availability);
  env.window.addEventListener('online', availability);
  env.window.addEventListener('offline', availability);
  availability();
  return () => {
    env.document.removeEventListener('visibilitychange', availability);
    env.window.removeEventListener('online', availability);
    env.window.removeEventListener('offline', availability);
    disconnect(false);
  };
}

type LiveUpdate = { kind?: string; coin?: Coin; trades?: Trade[] };
function parseUpdate(event?: Event): LiveUpdate | null {
  try {
    const data = (event as MessageEvent<string> | undefined)?.data;
    return data ? (JSON.parse(data) as LiveUpdate) : null;
  } catch {
    return null;
  }
}
const MAX_TRADES = 2000;
/** Applies a pushed update to the cache. Returns false when the page must refetch instead. */
export function applyUpdate(client: QueryClient, mint: string, update: LiveUpdate | null) {
  if (!update || (update.kind !== 'coin' && update.kind !== 'trades')) return false;
  if (update.coin?.mint === mint) client.setQueryData<Coin>(['coin', mint], update.coin);
  if (update.kind === 'trades') {
    const pushed = update.trades ?? [];
    client.setQueryData<TradesResponse>(['trades', mint], (current) => {
      if (!current) return current;
      const seen = new Set<string>();
      const trades = [...pushed, ...current.trades]
        .filter((trade) => {
          const id =
            trade.id ?? `${trade.sig}:${trade.instructionIndex ?? 0}:${trade.eventIndex ?? 0}`;
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        })
        .sort((a, b) => b.ts - a.ts)
        .slice(0, MAX_TRADES);
      return { ...current, trades };
    });
  }
  return true;
}
