import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { OTC_WALLET_HEADER } from '@/lib/otc';
import { PRIVATE_INVITE_TOKEN } from '@/lib/privateInvite';
import { apiGuard } from '@/server/apiGuard';
import { expectedGenesis } from '@/server/launchConfig';
import { otcConfig } from '@/server/otcConfig';
import { OtcStore, otcTerms } from '@/server/otcStore';
import { listOtcTokens, resolveOtcToken } from '@/server/otcToken';
import { derivePrivateKey } from '@/server/privateEncryption';
import { PrivateWalletAccess } from '@/server/privateWalletAccess';
import { ProfileStore, SocialError, socialSignature, socialWallet } from '@/server/profileStore';
import { siteOriginForHeaders } from '@/server/siteOrigin';

export const config = { api: { bodyParser: { sizeLimit: '4kb' } } };
const input = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('challenge'), wallet: socialWallet }),
  z.strictObject({
    action: z.literal('join'),
    wallet: socialWallet,
    nonce: z.string().regex(/^[a-f0-9]{64}$/),
    signature: socialSignature,
  }),
  z.strictObject({ action: z.literal('list') }),
  z.strictObject({ action: z.literal('asset'), mint: socialWallet }),
  z.strictObject({ action: z.literal('assets'), after: socialWallet.nullable() }),
  z.strictObject({
    action: z.literal('create'),
    terms: otcTerms,
    minutes: z.literal([15, 60, 1440]),
    viewerWallet: socialWallet.nullable(),
  }),
  z.strictObject({ action: z.literal('view'), token: z.string().regex(PRIVATE_INVITE_TOKEN) }),
  z.strictObject({
    action: z.literal('accept'),
    token: z.string().regex(PRIVATE_INVITE_TOKEN),
    signature: socialSignature,
  }),
  z.strictObject({ action: z.literal('revoke'), id: z.uuid() }),
]);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  const otc = otcConfig();
  if (!otc) return res.status(404).json({ error: 'OTC offers are unavailable here.' });
  if (!apiGuard(req, res)) return;
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
  const parsed = input.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: 'Check the offer details and try again.' });
  const payload = parsed.data;
  try {
    const origin = siteOriginForHeaders(req.headers);
    if (origin !== req.headers.origin)
      return res.status(403).json({ error: 'Request origin is not allowed.' });
    const genesis = expectedGenesis();
    const access = new PrivateWalletAccess(
      derivePrivateKey(otc.secret, 'mskd-confidential-otc/v1/session'),
      'otc',
      '__Host-mskd_otc',
      OTC_WALLET_HEADER,
      origin,
      genesis
    );

    if (payload.action === 'challenge')
      return res.status(200).json(await access.challenge(payload.wallet));
    if (payload.action === 'join') {
      await access.join(payload.wallet, payload.nonce, payload.signature, res);
      return res.status(200).json({ joined: true });
    }

    const wallet = access.wallet(req);
    const store = new OtcStore(otc.secret, genesis);
    if (payload.action === 'view')
      return res.status(200).json(await store.view(payload.token, wallet));
    if (!wallet) throw new SocialError('Unlock OTC with your wallet.', 401);

    switch (payload.action) {
      case 'accept':
        return res
          .status(200)
          .json(await store.accept(payload.token, wallet, origin, payload.signature));
      case 'list':
        return res.status(200).json({ offers: await store.list(wallet) });
      case 'asset':
        await new ProfileStore().limit(`otc-asset:${wallet}`, 40);
        return res.status(200).json(await resolveOtcToken(genesis, payload.mint));
      case 'assets':
        await new ProfileStore().limit(`otc-catalog:${wallet}`, 40);
        return res.status(200).json(await listOtcTokens(genesis, payload.after));
      case 'create': {
        await new ProfileStore().limit(`otc-create:${wallet}`, 12);
        const { sell, buy } = payload.terms;
        const verified = otcTerms.safeParse({
          sell:
            sell.asset === 'TOKEN'
              ? { ...sell, token: await resolveOtcToken(genesis, sell.token.mint) }
              : sell,
          buy:
            buy.asset === 'TOKEN'
              ? { ...buy, token: await resolveOtcToken(genesis, buy.token.mint) }
              : buy,
        });
        if (!verified.success)
          throw new SocialError('Check the offer amounts for the selected token.');
        return res
          .status(200)
          .json(await store.create(wallet, verified.data, payload.minutes, payload.viewerWallet));
      }
      case 'revoke':
        await store.revoke(wallet, payload.id);
        return res.status(200).json({ revoked: true });
    }
  } catch (error) {
    if (error instanceof SocialError)
      return res.status(error.status).json({ error: error.message });
    console.error('OTC offer request failed');
    return res.status(503).json({ error: 'OTC offers are temporarily unavailable.' });
  }
}
