import type { NextApiRequest, NextApiResponse } from 'next';
import { ringsAccess } from '@/server/otcRingsAccess';
import { ringsGatewayRequest, ringsGatewayTarget } from '@/server/otcRingsGateway';
import { ProfileStore, SocialError } from '@/server/profileStore';
import { readLimited } from '@/server/remote';
import { recordRpcUsage } from '@/server/rpcUsage';

export const config = { api: { bodyParser: { sizeLimit: '110kb' }, responseLimit: '2mb' } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const access = ringsAccess(req, res);
    if (!access) return;
    const parsed = ringsGatewayRequest.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid Rings request.' });
    const input = parsed.data;
    const room = await access.store.get(input.id, access.wallet);
    const { url, body, prove } = ringsGatewayTarget(input, room, access.config.rpc);
    if (prove) await new ProfileStore().limit(`otc-proof:${access.wallet}`, 12);
    const headers = new Headers(input.headers);
    if (prove && access.config.network !== 'localnet') {
      headers.delete('x-sync');
      headers.set('x-async', 'true');
    }
    recordRpcUsage(prove ? 'rings-proof' : 'rings-gateway');
    const response = await fetch(url, {
      method: input.method,
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(12000),
    });
    const content = response.body
      ? await readLimited(new Response(response.body, { headers: response.headers }), 1024 * 1024)
      : Buffer.alloc(0);
    const apiKey = url.searchParams.get('api-key');
    if (apiKey && content.includes(apiKey))
      return res.status(502).json({ error: 'Rings provider reply unavailable.' });
    for (const name of ['Content-Type', 'Spr-Tee', 'Retry-After']) {
      const value = response.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    return res.status(response.status).send(content);
  } catch (error) {
    if (error instanceof SocialError)
      return res.status(error.status).json({ error: error.message });
    console.error('Rings provider request failed');
    return res.status(503).json({ error: 'Rings provider is temporarily unavailable.' });
  }
}
