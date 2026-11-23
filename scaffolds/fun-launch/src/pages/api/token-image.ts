import type { NextApiRequest, NextApiResponse } from 'next';
import { apiGuard } from '@/server/apiGuard';
import { tokenImages } from '@/server/tokenImageCache';
import { metadataKey } from '@/server/offchainMetadataValue';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!apiGuard(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'HEAD')
    return res.status(405).json({ error: 'Method not allowed' });
  const uri = req.query.uri;
  try {
    if (typeof uri !== 'string' || Object.keys(req.query).length !== 1) throw new Error();
    metadataKey(uri);
  } catch {
    return res.status(400).json({ error: 'Invalid artwork URI' });
  }
  try {
    const image = await tokenImages.get(uri);
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-if-error=604800');
    res.setHeader('ETag', image.etag);
    if (req.headers['if-none-match'] === image.etag) return res.status(304).end();
    res.setHeader('Content-Length', image.bytes.length);
    return res.status(200).end(req.method === 'HEAD' ? undefined : image.bytes);
  } catch {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Retry-After', '30');
    return res.status(503).json({ error: 'Artwork temporarily unavailable' });
  }
}
