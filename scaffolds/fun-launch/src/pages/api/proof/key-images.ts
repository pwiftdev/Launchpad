import type { NextApiRequest, NextApiResponse } from 'next';
import { apiGuard } from '@/server/apiGuard';
import { networkGenesis } from '@/server/dbc';
import { latestKeyImages } from '@/server/proof';

/**
 * The Monero treasury's newest signed key images, as monero-wallet-rpc's import_key_images takes
 * them. Imported into a view-only wallet, they show what the treasury has spent.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!apiGuard(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Proof is unavailable' });
  try {
    const images = await latestKeyImages(await networkGenesis());
    if (!images) return res.status(404).json({ error: 'No key images are published yet' });
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="masked-key-images-${images.digest.slice(0, 12)}.json"`
    );
    return res
      .status(200)
      .json({ offset: images.offset, signed_key_images: images.signed_key_images });
  } catch (error) {
    console.error('Key image read failed', error instanceof Error ? error.message : error);
    return res.status(503).json({ error: 'Proof is temporarily unavailable' });
  }
}
