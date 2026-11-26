import { z } from 'zod';
import type { SolanaMarket } from '@/lib/solanaMarket';
import { readLimited } from './remote';

const MINUTE_MS = 60_000;
const HOUR_SECONDS = 3600;
const CANDLE_COUNT = 25;
const TTL_MS = 5 * MINUTE_MS;
const candle = z.tuple([
  z.number().int(),
  z.number(),
  z.number(),
  z.number(),
  z.number().positive(),
  z.number().nonnegative(),
]);
const candles = z.array(candle).max(300);
let reading: { value: number[]; expiresAt: number } | undefined;
let pending: Promise<void> | undefined;
let retryAt = 0;

async function loadHourlyCloses() {
  const end = Math.floor(Date.now() / 1000 / HOUR_SECONDS) * HOUR_SECONDS;
  const start = end - CANDLE_COUNT * HOUR_SECONDS;
  const url = new URL('https://api.exchange.coinbase.com/products/SOL-USD/candles');
  url.search = new URLSearchParams({
    granularity: String(HOUR_SECONDS),
    start: new Date(start * 1000).toISOString(),
    end: new Date(end * 1000).toISOString(),
  }).toString();
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(2500) });
  const body: unknown = JSON.parse((await readLimited(response, 32 * 1024)).toString('utf8'));
  const rows = candles
    .parse(body)
    .filter(([at]) => at >= start && at < end)
    .sort(([a], [b]) => a - b);
  if (rows.length !== CANDLE_COUNT || rows.some(([at], i) => at !== start + i * HOUR_SECONDS))
    throw new Error('Incomplete SOL price history');
  return rows.map((row) => row[4]);
}

export async function getSolanaMarket(): Promise<SolanaMarket> {
  const now = Date.now();
  if (now >= retryAt && (!reading || now >= reading.expiresAt)) {
    pending ??= loadHourlyCloses()
      .then((value) => {
        reading = { value, expiresAt: Date.now() + TTL_MS };
      })
      .catch(() => {
        retryAt = Date.now() + MINUTE_MS;
      })
      .finally(() => {
        pending = undefined;
      });
    await pending;
  }
  const at = Date.now();
  return {
    hourlyCloses:
      reading && at < reading.expiresAt + 60 * MINUTE_MS
        ? { value: reading.value, stale: at >= reading.expiresAt }
        : null,
  };
}
