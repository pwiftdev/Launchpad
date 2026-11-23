import { apiGuard } from '@/server/apiGuard';
import type { NextApiRequest, NextApiResponse } from 'next';
import { checkLaunch, type Rejection } from '@/server/antivamp';

export type LaunchCheckResponse = { ok: true } | ({ ok: false } & Rejection);

/**
 * GET /api/launch-check?name=&symbol=&sourceUrl= : live anti-vamp pre-check for the launch form.
 * The image rule runs at launch time, when the image is uploaded.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<LaunchCheckResponse | { error: string }>
) {
  if (!apiGuard(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const name = String(req.query.name ?? '').slice(0, 32);
  const symbol = String(req.query.symbol ?? '').slice(0, 10);
  const sourceUrl = String(req.query.sourceUrl ?? '').slice(0, 2048) || undefined;
  if (!symbol) return res.status(400).json({ error: 'Add a ticker' });
  try {
    const rejection = await checkLaunch({ name, symbol, sourceUrl });
    res.status(200).json(rejection ? { ok: false, ...rejection } : { ok: true });
  } catch {
    console.error('Launch check request failed');
    res.status(500).json({ error: 'Check failed' });
  }
}
