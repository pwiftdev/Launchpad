import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { PREVIEW_TOKEN_PATTERN, PREVIEW_WALLET_HEADER } from '@/lib/launchPreview';
import { apiGuard } from '@/server/apiGuard';
import { expectedGenesis } from '@/server/launchConfig';
import { LaunchPreviewStore, launchPreviewDraft } from '@/server/launchPreviewStore';
import {
  derivePrivateKey,
  privateCookie,
  launchPreviewKey,
  privateSession,
  readPrivateSession,
} from '@/server/privateEncryption';
import { ProfileStore, SocialError, socialSignature, socialWallet } from '@/server/profileStore';
import { siteOriginForHeaders } from '@/server/siteOrigin';

export const config = { api: { bodyParser: { sizeLimit: '8mb' } } };
const COOKIE = '__Host-mskd_preview';
const PURPOSE = 'launch-preview';
const revision = z.int().min(0).max(2_147_483_646);
const token = z.string().regex(PREVIEW_TOKEN_PATTERN);
const input = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('challenge'), wallet: socialWallet }),
  z.strictObject({
    action: z.literal('join'),
    wallet: socialWallet,
    nonce: z.string().regex(/^[a-f0-9]{64}$/),
    signature: socialSignature,
  }),
  z.strictObject({ action: z.literal('load'), includeDraft: z.boolean().default(true) }),
  z.strictObject({ action: z.literal('save'), revision, draft: launchPreviewDraft }),
  z.strictObject({
    action: z.literal('invite'),
    revision: revision.min(1),
    hours: z.literal([1, 24, 168]),
    viewerWallet: socialWallet.nullable(),
  }),
  z.strictObject({ action: z.literal('revoke'), id: z.uuid() }),
  z.strictObject({ action: z.literal('view'), token }),
  z.strictObject({ action: z.literal('check'), token }),
]);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'private, no-store');
  if (!apiGuard(req, res)) return;
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const secret = launchPreviewKey();
  if (!secret)
    return res.status(503).json({ error: 'Private previews are temporarily unavailable.' });

  try {
    const origin = siteOriginForHeaders(req.headers);
    if (req.headers.origin !== origin)
      return res.status(403).json({ error: 'Request origin is not allowed.' });
    const genesis = expectedGenesis();
    const sessionKey = derivePrivateKey(secret, 'mskd-launch-preview/v1/session');
    const payload = input.parse(req.body);
    if (payload.action === 'challenge')
      return res.status(200).json(
        await new ProfileStore().challenge(payload.wallet, PURPOSE, origin, {
          networkGenesis: genesis,
        })
      );
    if (payload.action === 'join') {
      const result = await new ProfileStore().submit(
        payload.wallet,
        PURPOSE,
        origin,
        payload.nonce,
        payload.signature
      );
      if (!z.object({ networkGenesis: z.literal(genesis) }).safeParse(result).success)
        throw new SocialError('Sign in with the current network.', 401);
      const session = privateSession(sessionKey, payload.wallet, origin, genesis);
      res.setHeader('Set-Cookie', privateCookie(COOKIE, session));
      return res.status(200).json({ joined: true });
    }

    const sessionWallet = readPrivateSession(sessionKey, req.cookies?.[COOKIE], origin, genesis);
    const wallet =
      req.headers[PREVIEW_WALLET_HEADER.toLowerCase()] === sessionWallet ? sessionWallet : null;
    const store = new LaunchPreviewStore(secret, genesis);
    if (payload.action === 'view' || payload.action === 'check')
      return res
        .status(200)
        .json(await store.view(payload.token, wallet, payload.action === 'view'));
    if (!wallet) throw new SocialError('Unlock your private previews with your wallet.', 401);
    switch (payload.action) {
      case 'load':
        return res.status(200).json(await store.load(wallet, payload.includeDraft));
      case 'save':
        await new ProfileStore().limit(`preview-save:${wallet}`, 30);
        return res.status(200).json(await store.save(wallet, payload.revision, payload.draft));
      case 'invite':
        await new ProfileStore().limit(`preview-invite:${wallet}`, 12);
        return res
          .status(200)
          .json(await store.invite(wallet, payload.revision, payload.hours, payload.viewerWallet));
      case 'revoke':
        await store.revoke(wallet, payload.id);
        return res.status(200).json({ revoked: true });
    }
  } catch (error) {
    if (error instanceof SocialError)
      return res.status(error.status).json({ error: error.message });
    if (error instanceof z.ZodError)
      return res.status(400).json({ error: 'Check the preview details and try again.' });
    console.error('Private launch preview request failed');
    return res.status(503).json({ error: 'Private previews are temporarily unavailable.' });
  }
}
