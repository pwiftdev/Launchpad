import type { NextApiRequest, NextApiResponse } from 'next';
import { apiGuard, takeLimit, clientIp } from '@/server/apiGuard';
import { connection, getCoin, parseKey, invalidateCoinDisplay } from '@/server/dbc';
import { invalidateTradeHistory } from '@/server/trades';
import { CoinLiveHub } from '@/server/liveCoin';
const hub = new CoinLiveHub(connection, (mint, pools) => {
  invalidateCoinDisplay(mint);
  for (const pool of pools) invalidateTradeHistory(pool);
});
export const config = { api: { responseLimit: false } };
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!apiGuard(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const key = parseKey(req.query.mint);
  if (!key) return res.status(400).json({ error: 'Invalid mint' });
  if (!takeLimit(`coin-live:${clientIp(req)}`, 20, 60000))
    return res.status(429).json({ error: 'Live feed reconnect limit reached' });
  let release: (() => void) | undefined,
    heartbeat: ReturnType<typeof setInterval> | undefined,
    expiry: ReturnType<typeof setTimeout> | undefined,
    closed = false;
  const stop = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (expiry) clearTimeout(expiry);
    release?.();
    if (!res.writableEnded) res.end();
  };
  try {
    const found = await getCoin(key.toBase58(), { fresh: false });
    if (!found) return res.status(404).json({ error: 'Coin not found' });
    if (req.aborted || res.destroyed) return;
    release = hub.subscribe(
      key.toBase58(),
      [found.coin.pool, ...(found.coin.migratedPool ? [found.coin.migratedPool] : [])],
      (event) => {
        if (closed || res.writableEnded) return;
        if (!res.write(`event: update\ndata: ${JSON.stringify(event)}\n\n`)) stop();
      }
    );
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'private, no-store, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write('event: ready\ndata: {}\n\n');
    heartbeat = setInterval(() => {
      if (!closed && !res.writableEnded && !res.write(': heartbeat\n\n')) stop();
    }, 10000);
    heartbeat.unref();
    expiry = setTimeout(stop, 40000);
    expiry.unref();
    res.on('close', stop);
    req.on('aborted', stop);
  } catch {
    release?.();
    if (res.headersSent) stop();
    else res.status(503).json({ error: 'Live updates unavailable; polling remains available' });
  }
}
