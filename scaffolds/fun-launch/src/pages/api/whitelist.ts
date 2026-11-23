import type { NextApiRequest, NextApiResponse } from 'next';
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import { apiGuard, clientIp } from '@/server/apiGuard';
import {
  createChallenge,
  findReferrer,
  getChallenge,
  getRegistration,
  registerWallet,
  whitelistCount,
  whitelistLimit,
} from '@/server/whitelistStore';
import { parseReferralCode } from '@/lib/whitelist';
import { siteOriginForHeaders } from '@/server/siteOrigin';
import {
  readWhitelistSession,
  signWhitelistSession,
  verifyWalletMessage,
  whitelistSecret,
} from '@/server/whitelistAuth';

export const config = { api: { bodyParser: { sizeLimit: '4kb' } } };
const wallet = z
  .string()
  .min(32)
  .max(44)
  .refine((value) => {
    try {
      return PublicKey.isOnCurve(new PublicKey(value).toBytes());
    } catch {
      return false;
    }
  });
const challengeSchema = z
  .object({
    action: z.literal('challenge'),
    wallet,
    interest: z.enum(['trader', 'creator', 'both']),
    referralCode: z
      .string()
      .regex(/^[A-Z0-9]{8}$/)
      .optional(),
  })
  .strict();

const shortWallet = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;
const registrationSchema = z
  .object({
    action: z.literal('register'),
    wallet,
    nonce: z.string().regex(/^[a-f0-9]{64}$/),
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  })
  .strict();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Cookie');
  if (!apiGuard(req, res)) return;
  if (!['GET', 'POST'].includes(req.method ?? ''))
    return res.status(405).json({ error: 'Method not allowed' });
  if (process.env.WHITELIST_ENABLED !== 'true' || !process.env.DATABASE_URL)
    return res
      .status(503)
      .json({ error: 'Registration is temporarily unavailable. Please try again shortly.' });
  try {
    whitelistSecret();
    if (req.method === 'GET') {
      // Public: how many wallets are on the list, and who sent a ?ref= visitor (shortened)
      const refCode = parseReferralCode(req.query.ref);
      const [count, referrer] = await Promise.all([
        whitelistCount(),
        refCode ? findReferrer(refCode) : Promise.resolve(null),
      ]);
      const invitedBy = referrer ? shortWallet(referrer) : null;
      const session = readWhitelistSession(req.cookies.rinsed_whitelist);
      if (!session) return res.status(200).json({ registration: null, count, invitedBy });
      return res.status(200).json({
        registration: await getRegistration(session.wallet, session.registrationId),
        count,
        invitedBy,
      });
    }
    const challenge = challengeSchema.safeParse(req.body);
    if (challenge.success) {
      if (
        !(await whitelistLimit('challenge-global', 5000)) ||
        !(await whitelistLimit(`challenge-ip:${clientIp(req)}`, 60)) ||
        !(await whitelistLimit(`challenge-wallet:${challenge.data.wallet}`, 12))
      ) {
        res.setHeader('Retry-After', '3600');
        return res.status(429).json({ error: 'Too many registration attempts. Try again later.' });
      }
      const origin = siteOriginForHeaders(req.headers);
      return res
        .status(200)
        .json(
          await createChallenge(
            challenge.data.wallet,
            challenge.data.interest,
            origin,
            challenge.data.referralCode ?? null
          )
        );
    }
    const registration = registrationSchema.safeParse(req.body);
    if (!registration.success)
      return res.status(400).json({ error: 'Invalid registration request' });
    if (!(await whitelistLimit(`register-ip:${clientIp(req)}`, 120)))
      return res.status(429).json({ error: 'Too many registration attempts. Try again later.' });
    const { nonce, wallet: address, signature } = registration.data;
    const saved = await getChallenge(nonce, address);
    if (!saved)
      return res
        .status(409)
        .json({ error: 'This request expired or was already used. Please try again.' });
    if (!verifyWalletMessage(address, saved.message, signature))
      return res.status(401).json({ error: 'Wallet signature could not be verified' });
    const receipt = await registerWallet(nonce, address, signature);
    if (!receipt)
      return res
        .status(409)
        .json({ error: 'This request expired or was already used. Please try again.' });
    if (receipt.status === 'revoked')
      return res
        .status(403)
        .json({ error: 'This registration is unavailable. Contact support for assistance.' });
    const token = signWhitelistSession(address, receipt.registrationId);
    res.setHeader(
      'Set-Cookie',
      `rinsed_whitelist=${token}; HttpOnly; Secure; SameSite=Strict; Path=/api/whitelist; Max-Age=2592000`
    );
    return res.status(200).json({ registration: receipt, count: await whitelistCount(true) });
  } catch {
    console.error('Whitelist service could not complete a request');
    return res
      .status(503)
      .json({ error: 'Registration is temporarily unavailable. Please try again shortly.' });
  }
}
