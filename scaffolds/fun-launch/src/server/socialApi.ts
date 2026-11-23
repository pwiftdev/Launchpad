import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { apiGuard } from './apiGuard';
import { siteOriginForHeaders } from './siteOrigin';
import { expectedGenesis } from './launchConfig';
import {
  ProfileStore,
  SocialError,
  socialMint,
  socialSignature,
  socialWallet,
  profileDraft,
} from './profileStore';

const submit = z
  .object({
    action: z.literal('submit'),
    wallet: socialWallet,
    nonce: z.string().regex(/^[a-f0-9]{64}$/),
    signature: socialSignature,
  })
  .strict();
const profileChallenge = z
  .object({ action: z.literal('challenge'), wallet: socialWallet, payload: profileDraft })
  .strict();
const calloutChallenge = z
  .object({
    action: z.literal('challenge'),
    wallet: socialWallet,
    payload: z.object({ mint: socialMint, body: z.string().max(500) }).strict(),
  })
  .strict();
export function socialApi(purpose: 'profile' | 'callout') {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!apiGuard(req, res)) return;
    if (!['GET', 'POST'].includes(req.method ?? ''))
      return res.status(405).json({ error: 'Method not allowed' });
    if (!process.env.DATABASE_URL)
      return res.status(503).json({ error: 'Profiles are temporarily unavailable.' });
    try {
      const store = new ProfileStore();
      if (req.method === 'GET') {
        if (purpose === 'profile') {
          if (typeof req.query.wallets !== 'string' || req.query.wallets.length > 2250)
            throw new SocialError('Specify up to 50 wallet addresses.');
          const wallets = z
            .array(socialMint)
            .min(1)
            .max(50)
            .parse([...new Set(req.query.wallets.split(','))]);
          return res.status(200).json({ profiles: await store.profiles(wallets) });
        }
        const mint = socialMint.parse(req.query.mint);
        const before =
          req.query.before === undefined
            ? null
            : z
                .string()
                .regex(/^[1-9][0-9]{0,17}$/)
                .parse(req.query.before);
        const callouts = await store.callouts(expectedGenesis(), mint, before);
        return res
          .status(200)
          .json({ callouts, nextBefore: callouts.length === 20 ? callouts.at(-1)?.id : null });
      }
      const origin = siteOriginForHeaders(req.headers);
      const challenge = (purpose === 'profile' ? profileChallenge : calloutChallenge).safeParse(
        req.body
      );
      if (challenge.success) {
        const payload =
          purpose === 'profile'
            ? challenge.data.payload
            : { ...challenge.data.payload, networkGenesis: expectedGenesis() };
        return res
          .status(200)
          .json(await store.challenge(challenge.data.wallet, purpose, origin, payload));
      }
      const input = submit.parse(req.body);
      const value = await store.submit(input.wallet, purpose, origin, input.nonce, input.signature);
      return res.status(200).json(purpose === 'profile' ? { profile: value } : { callout: value });
    } catch (error) {
      if (error instanceof SocialError)
        return res.status(error.status).json({ error: error.message });
      if (error instanceof z.ZodError)
        return res
          .status(400)
          .json({ error: 'Check the address, username, avatar URL and text length.' });
      console.error('Wallet social request failed');
      return res.status(503).json({
        error: 'Unable to save or load this request. Refresh to check before trying again.',
      });
    }
  };
}
