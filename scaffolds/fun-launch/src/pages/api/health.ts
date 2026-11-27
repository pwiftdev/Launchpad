import type { NextApiRequest, NextApiResponse } from 'next';
import { displayStore, sharedClock } from '@/server/display';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).end();
  res.setHeader('Cache-Control', 'no-store');
  if (req.query.check === 'display') {
    try {
      const store = displayStore();
      if (store && !(await sharedClock(store)).clockStale)
        return res.status(200).json({ status: 'ok' });
    } catch {}
    return res.status(503).json({ status: 'unavailable' });
  }
  return res.status(200).json({ status: 'ok' });
}
