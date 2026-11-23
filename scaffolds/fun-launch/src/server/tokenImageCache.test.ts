import { expect, it, vi } from 'vitest';
import sharp from 'sharp';
import type { Pool, PoolClient } from 'pg';
import { TokenImageCache } from './tokenImageCache';
const uri =
  'https://gateway.pinata.cloud/ipfs/bafkreihcfu4dqmbr5iyacioofllgwl2m7sv22bo6woiya6rpiwwcj6ksoi';
it('retains decoded artwork across cache instances when gateways go offline', async () => {
  let saved: Buffer | undefined;
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.startsWith('UPDATE token_image_cache'))
      return { rows: saved ? [{ uri, image: saved }] : [] };
    if (sql.startsWith('INSERT INTO token_image_cache')) saved = values![2] as Buffer;
    return { rows: [] };
  });
  const db = {
    query,
    connect: async () => ({ query, release: () => {} }) as unknown as PoolClient,
  } as unknown as Pick<Pool, 'query' | 'connect'>;
  const png = await sharp({
    create: { width: 800, height: 800, channels: 4, background: '#ff0055' },
  })
    .png()
    .toBuffer();
  const download = vi.fn(async () => png),
    cache = new TokenImageCache(db, download);
  const [first, second] = await Promise.all([cache.get(uri), cache.get(uri)]);
  expect(first.etag).toBe(second.etag);
  expect(download).toHaveBeenCalledOnce();
  expect((await sharp(first.bytes).metadata()).width).toBe(512);
  const offline = vi.fn(async (): Promise<Buffer> => {
    throw new Error('Gateway unavailable');
  });
  expect((await new TokenImageCache(db, offline).get(uri)).etag).toBe(first.etag);
  expect(offline).not.toHaveBeenCalled();
  await expect(cache.get('https://127.0.0.1/private')).rejects.toThrow();
});
it('never stores an HTML response as token artwork', async () => {
  const query = vi.fn(async () => ({ rows: [] }));
  const db = { query } as unknown as Pick<Pool, 'query' | 'connect'>;
  const cache = new TokenImageCache(db, async () => Buffer.from('<html>gateway error</html>'));
  await expect(cache.get(uri)).rejects.toThrow();
  expect(query).toHaveBeenCalledOnce();
});
