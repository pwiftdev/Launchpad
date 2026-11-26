import { useEffect, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { Coin, CoinsResponse } from '@/lib/coin';

/** Board refetches are batched: a busy launchpad sends many updates per second. */
const BOARD_REFRESH_MS = 1500;
/** Trending and launchpad totals do not need every swap. */
const SUMMARY_REFRESH_MS = 15_000;
type Board = {
  source?: EventSource;
  users: number;
  connected: boolean;
  listeners: Set<(connected: boolean) => void>;
  clients: Map<QueryClient, number>;
  timer?: ReturnType<typeof setTimeout>;
};
const board: Board = { users: 0, connected: false, listeners: new Set(), clients: new Map() };

function setConnected(value: boolean) {
  board.connected = value;
  for (const listener of board.listeners) listener(value);
}

/** Reloads the list (coins added or removed); rankings and totals follow at a slower pace. */
function refresh() {
  if (board.timer) return;
  board.timer = setTimeout(() => {
    board.timer = undefined;
    for (const client of board.clients.keys())
      void client.invalidateQueries({ queryKey: ['coins'] });
  }, BOARD_REFRESH_MS);
}
let summariesAt = 0;
function refreshSummaries() {
  if (Date.now() - summariesAt < SUMMARY_REFRESH_MS) return;
  summariesAt = Date.now();
  for (const client of board.clients.keys())
    for (const queryKey of [['trending'], ['market-stats']])
      void client.invalidateQueries({ queryKey });
}
/** A changed coin arrives in the event: patch it in place, no request needed. */
function update(event: Event) {
  let data: { kind?: string; coin?: Coin } = {};
  try {
    data = JSON.parse((event as MessageEvent<string>).data);
  } catch {
    return refresh();
  }
  if (data.kind !== 'coin' || !data.coin) return refresh();
  const coin = data.coin;
  for (const client of board.clients.keys()) {
    let found = false;
    client.setQueryData<CoinsResponse>(['coins'], (current) => {
      if (!current) return current;
      const coins = current.coins.map((item) => {
        if (item.mint !== coin.mint) return item;
        found = true;
        return coin;
      });
      return found ? { ...current, coins } : current;
    });
    if (!found) refresh();
    client.setQueryData<Coin>(['coin', coin.mint], (current) => (current ? coin : current));
  }
  refreshSummaries();
}

function open() {
  if (board.source || document.hidden || navigator.onLine === false) return;
  const source = new EventSource('/api/live');
  board.source = source;
  source.addEventListener('ready', () => {
    setConnected(true);
    refresh();
  });
  source.addEventListener('update', update);
  source.onerror = () => setConnected(false);
}

function close() {
  board.source?.close();
  board.source = undefined;
  setConnected(false);
}

const availability = () => (document.hidden || navigator.onLine === false ? close() : open());

/**
 * One stream per tab for the whole board. While it is connected, board queries refetch on
 * change instead of on a timer; hidden or offline tabs hold no connection.
 */
export function useBoardLive(enabled = true) {
  const client = useQueryClient();
  const [connected, setState] = useState(board.connected);
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    board.users++;
    board.clients.set(client, (board.clients.get(client) ?? 0) + 1);
    board.listeners.add(setState);
    if (board.users === 1) {
      document.addEventListener('visibilitychange', availability);
      window.addEventListener('online', availability);
      window.addEventListener('offline', availability);
    }
    open();
    setState(board.connected);
    return () => {
      board.listeners.delete(setState);
      const users = board.clients.get(client) ?? 1;
      if (users === 1) board.clients.delete(client);
      else board.clients.set(client, users - 1);
      if (--board.users === 0) {
        document.removeEventListener('visibilitychange', availability);
        window.removeEventListener('online', availability);
        window.removeEventListener('offline', availability);
        if (board.timer) clearTimeout(board.timer);
        board.timer = undefined;
        close();
      }
    };
  }, [client, enabled]);
  return { connected };
}
