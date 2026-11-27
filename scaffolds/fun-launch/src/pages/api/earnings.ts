import { createHash } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import { apiGuard, takeLimit } from '@/server/apiGuard';
import { connection, networkGenesis } from '@/server/dbc';
import { expectedGenesis } from '@/server/launchConfig';
import { siteOriginForHeaders } from '@/server/siteOrigin';
import { assertWalletExecutionGate } from '@/server/economics/walletGate';
import {
  assertWalletRecipientCredit,
  WalletRecipientUnavailable,
} from '@/server/economics/walletRecipient';
import { MaskedClaimError, MaskedClaimStore } from '@/server/economics/maskedClaimStore';
import { verifyWalletSignature } from '@/server/economics/walletSignature';
import { maskedClaimMessage } from '@/lib/maskedEarnings';

export const config = { api: { bodyParser: { sizeLimit: '3kb' } } };

const address = z
  .string()
  .min(32)
  .max(44)
  .refine((value) => {
    try {
      return new PublicKey(value).toBase58() === value;
    } catch {
      return false;
    }
  });
const claim = z
  .object({
    action: z.literal('claim'),
    networkGenesis: address,
    wallet: address,
    currency: z.enum(['wxmr', 'sol']),
    lamports: z.string().regex(/^[1-9]\d{0,19}$/),
    requestId: z.string().uuid(),
    issuedAt: z.number().int(),
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  })
  .strict();

const store = new MaskedClaimStore();

/** A wallet's Masked earnings and its signed wXMR or SOL claim. */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!apiGuard(req, res)) return;
  res.setHeader('Cache-Control', 'private, no-store');
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Earnings are unavailable' });
  try {
    if (req.method === 'GET') {
      const wallet = address.safeParse(req.query.wallet);
      if (!wallet.success) return res.status(400).json({ error: 'Invalid wallet' });
      return res.status(200).json(await store.earnings(expectedGenesis(), wallet.data));
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const parsed = claim.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid claim' });
    const input = parsed.data;
    const genesis = await networkGenesis();
    if (input.networkGenesis !== genesis)
      return res.status(409).json({ error: 'The network changed. Reload before claiming.' });
    const now = Date.now();
    if (input.issuedAt > now + 30_000 || input.issuedAt < now - 300_000)
      return res.status(401).json({ error: 'This signature expired. Sign again.' });
    const origin = siteOriginForHeaders(req.headers);
    const message = maskedClaimMessage(origin, input);
    if (!verifyWalletSignature(input.wallet, message, input.signature))
      return res.status(401).json({ error: 'Sign the claim with the wallet that earned it' });
    if (!takeLimit(`masked-claim:${genesis}:${input.wallet}`, 6, 60_000))
      return res.status(429).json({ error: 'Too many claims. Check your open claim first.' });
    try {
      await assertWalletExecutionGate(connection, genesis);
    } catch {
      return res
        .status(503)
        .json({ error: 'Claims are paused on this network. Your earnings stay saved.' });
    }
    if (input.currency === 'sol')
      try {
        await assertWalletRecipientCredit(
          connection,
          new PublicKey(input.wallet),
          BigInt(input.lamports)
        );
      } catch (error) {
        if (error instanceof WalletRecipientUnavailable)
          return res.status(400).json({
            error: 'Earn a little more or fund your wallet with some SOL before a SOL payout.',
          });
        throw error;
      }
    const result = await store.requestClaim({
      networkGenesis: genesis,
      wallet: input.wallet,
      currency: input.currency,
      lamports: BigInt(input.lamports),
      requestId: input.requestId,
      authorizationDigest: createHash('sha256').update(message).digest('hex'),
    });
    return res.status(202).json(result);
  } catch (error) {
    if (error instanceof MaskedClaimError)
      return res.status(error.status).json({ error: error.message });
    console.error(
      `Earnings request failed: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`
    );
    return res
      .status(503)
      .json({ error: 'Earnings are temporarily unavailable. Check your claims before retrying.' });
  }
}
