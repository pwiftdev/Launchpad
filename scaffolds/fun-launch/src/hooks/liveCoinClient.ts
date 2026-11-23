import type { QueryClient } from '@tanstack/react-query';
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
      let holdersAt = 0;
      source.addEventListener('ready', () => {
        if (!created.users) return;
        status(true);
        invalidate(true);
      });
      source.addEventListener('update', () => {
        if (created.timer || !created.users) return;
        created.timer = setTimeout(() => {
          created.timer = undefined;
          if (!created.users) return;
          const holders = Date.now() - holdersAt >= 4000;
          if (holders) holdersAt = Date.now();
          invalidate(holders);
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
