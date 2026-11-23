import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { verifyAdminKey } from '../../../../../../scripts/admin-key.cjs';
import { apiGuard, clientIp } from '@/server/apiGuard';
import { whitelistLimit } from '@/server/whitelistStore';
import { siteOriginForHeaders } from '@/server/siteOrigin';
import {
  ADMIN_COOKIE,
  adminConfigured,
  adminCookie,
  readAdminSession,
  signAdminSession,
} from '@/server/adminSession';

export const config = { api: { bodyParser: { sizeLimit: '2kb' } } };
const login = z.object({ action: z.literal('login'), key: z.string().min(16).max(256) }).strict();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Vary', 'Cookie');
  if (!apiGuard(req, res)) return;
  if (req.method === 'GET')
    return res.status(200).json({ authenticated: readAdminSession(req.cookies[ADMIN_COOKIE]) });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (
    z
      .object({ action: z.literal('logout') })
      .strict()
      .safeParse(req.body).success
  ) {
    res.setHeader('Set-Cookie', adminCookie('', 0));
    return res.status(200).json({ authenticated: false });
  }
  if (!adminConfigured())
    return res
      .status(503)
      .json({ error: 'Admin access is locked until private setup is complete.' });
  try {
    // Reuse the persistent, keyed IP buckets; failures are never logged with the submitted key.
    if (!(await whitelistLimit(`admin-login-ip:${clientIp(req)}`, 10))) {
      res.setHeader('Retry-After', '3600');
      return res.status(429).json({ error: 'Too many sign-in attempts. Try again later.' });
    }
    if (!(await whitelistLimit('admin-login-global', 100)))
      return res.status(429).json({ error: 'Sign-in is temporarily limited. Try again later.' });
    const parsed = login.safeParse(req.body);
    if (!parsed.success || !(await verifyAdminKey(parsed.data.key, process.env.ADMIN_KEY_HASH)))
      return res.status(401).json({ error: 'Invalid admin key' });
    res.setHeader(
      'Set-Cookie',
      adminCookie(signAdminSession(Date.now(), siteOriginForHeaders(req.headers)))
    );
    return res.status(200).json({ authenticated: true });
  } catch {
    return res.status(503).json({ error: 'Admin sign-in is temporarily unavailable.' });
  }
}
