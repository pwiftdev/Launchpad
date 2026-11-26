import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { apiGuard } from '@/server/apiGuard';
import {
  CHAT_COOKIE,
  chatCookie,
  chatKey,
  chatSession,
  readChatSession,
} from '@/server/chatSecurity';
import { ChatStore } from '@/server/chatStore';
import { expectedGenesis } from '@/server/launchConfig';
import {
  chatBody,
  ProfileStore,
  SocialError,
  socialMint,
  socialSignature,
  socialWallet,
} from '@/server/profileStore';
import { siteOriginForHeaders } from '@/server/siteOrigin';

export const config = { api: { bodyParser: { sizeLimit: '4kb' } } };
const feed = z
  .object({
    mint: socialMint,
    before: z
      .string()
      .regex(/^[1-9]\d{0,17}$/)
      .optional(),
  })
  .strict();
const input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('challenge'), mint: socialMint, wallet: socialWallet }).strict(),
  z
    .object({
      action: z.literal('join'),
      wallet: socialWallet,
      nonce: z.string().regex(/^[a-f0-9]{64}$/),
      signature: socialSignature,
    })
    .strict(),
  z
    .object({ action: z.literal('post'), mint: socialMint, clientId: z.uuid(), body: chatBody })
    .strict(),
  z.object({ action: z.literal('leave') }).strict(),
]);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Vary', 'Cookie, X-Chat-Wallet');
  if (!apiGuard(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });
  const secret = chatKey();
  if (!secret || !process.env.DATABASE_URL)
    return res.status(503).json({ error: 'Token chat is temporarily unavailable.' });
  try {
    const origin = siteOriginForHeaders(req.headers);
    const genesis = expectedGenesis();
    const payload = req.method === 'POST' ? input.parse(req.body) : null;
    if (payload && req.headers.origin !== origin)
      return res.status(403).json({ error: 'Request origin is not allowed' });
    if (payload?.action === 'challenge')
      return res.status(200).json(
        await new ProfileStore().challenge(payload.wallet, 'chat', origin, {
          networkGenesis: genesis,
          mint: payload.mint,
        })
      );
    if (payload?.action === 'join') {
      const signed = await new ProfileStore().submit(
        payload.wallet,
        'chat',
        origin,
        payload.nonce,
        payload.signature
      );
      const joined = z.object({ networkGenesis: z.literal(genesis) }).safeParse(signed);
      if (!joined.success)
        return res.status(401).json({ error: 'Sign in with the current network.' });
      res.setHeader('Set-Cookie', chatCookie(chatSession(secret, payload.wallet, origin, genesis)));
      return res.status(200).json({ joined: true });
    }
    if (payload?.action === 'leave') {
      res.setHeader('Set-Cookie', chatCookie('', 0));
      return res.status(200).json({ joined: false });
    }
    const wallet = readChatSession(secret, req.cookies?.[CHAT_COOKIE], origin, genesis);
    if (!wallet || req.headers['x-chat-wallet'] !== wallet)
      return res.status(401).json({ error: 'Sign in with your wallet to join chat.' });
    const store = new ChatStore();
    if (payload) {
      await new ProfileStore().limit(`chat-post:${wallet}`, 120);
      await store.post(secret, genesis, payload.mint, wallet, payload.clientId, payload.body);
      return res.status(200).json({ saved: true });
    }
    const room = feed.parse(req.query);
    const history = await store.feed(secret, genesis, room.mint, wallet, room.before ?? null);
    return history
      ? res.status(200).json(history)
      : res.status(404).json({ error: 'Chat is unavailable for this token.' });
  } catch (error) {
    if (error instanceof SocialError)
      return res.status(error.status).json({ error: error.message });
    if (error instanceof z.ZodError)
      return res.status(400).json({ error: 'Invalid chat request.' });
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23503')
      return res.status(404).json({ error: 'Chat is unavailable for this token.' });
    console.error('Token chat request failed');
    return res.status(503).json({ error: 'Token chat is temporarily unavailable.' });
  }
}
