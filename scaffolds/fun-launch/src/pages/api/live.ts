import type { NextApiRequest, NextApiResponse } from 'next';
import { apiGuard, takeLimit, clientIp } from '@/server/apiGuard';
import { displayStore, sharedCoin } from '@/server/display';
import { streamLive } from '@/server/liveStream';

export const config = { api: { responseLimit: false } };

/**
 * Live updates for the whole board. A changed coin is sent in the event itself, so a thousand
 * viewers patch their board instead of a thousand refetches; only added or removed coins
 * (`board`) ask the browser to reload the list.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!apiGuard(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!takeLimit(`board-live:${clientIp(req)}`, 20, 60000))
    return res.status(429).json({ error: 'Live feed reconnect limit reached' });
  const store = displayStore();
  if (!store) return res.status(503).json({ error: 'Live updates unavailable' });
  await streamLive(req, res, 'board', async (event) => {
    if (event.kind === 'board') return { kind: 'board' };
    if (event.kind !== 'coin') return null;
    const coin = await sharedCoin(store, event.mint);
    return coin ? { kind: 'coin', coin } : null;
  });
}
