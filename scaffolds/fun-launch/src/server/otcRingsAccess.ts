import type { NextApiRequest, NextApiResponse } from 'next';
import { OTC_WALLET_HEADER } from '@/lib/otc';
import { apiGuard } from './apiGuard';
import { expectedGenesis } from './launchConfig';
import { otcRingsConfig } from './otcRingsConfig';
import { OtcRingsStore } from './otcRingsStore';
import { derivePrivateKey } from './privateEncryption';
import { PrivateWalletAccess } from './privateWalletAccess';
import { siteOriginForHeaders } from './siteOrigin';

export function ringsAccess(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  const config = otcRingsConfig();
  if (!config) {
    res.status(404).json({ error: 'Rings settlement is unavailable.' });
    return null;
  }
  if (!apiGuard(req, res)) return null;
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return null;
  }
  const origin = siteOriginForHeaders(req.headers);
  if (origin !== req.headers.origin) {
    res.status(403).json({ error: 'Request origin is not allowed.' });
    return null;
  }
  const genesis = expectedGenesis();
  const wallet = new PrivateWalletAccess(
    derivePrivateKey(config.secret, 'mskd-confidential-otc/v1/session'),
    'otc',
    '__Host-mskd_otc',
    OTC_WALLET_HEADER,
    origin,
    genesis
  ).wallet(req);
  if (!wallet) {
    res.status(401).json({ error: 'Unlock OTC with your wallet.' });
    return null;
  }
  return { config, origin, wallet, genesis, store: new OtcRingsStore(config.secret, genesis) };
}
