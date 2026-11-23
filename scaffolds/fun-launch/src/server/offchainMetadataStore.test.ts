import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { PostgresOffchainMetadataStore } from './offchainMetadataStore';
import { OffchainMetadataCache } from './offchainMetadata';
import { metadataKey, METADATA_LIMITS } from './offchainMetadataValue';
import { fetchRemote } from './remote';
vi.mock('./remote', async (original) => ({
  ...(await original<typeof import('./remote')>()),
  fetchRemote: vi.fn(),
}));
const fetch = vi.mocked(fetchRemote),
  uri = 'ipfs://bafkreihcfu4dqmbr5iyacioofllgwl2m7sv22bo6woiya6rpiwwcj6ksoi',
  key = metadataKey(uri),
  image = key.uri;
let db: PGlite,
  pool: Pick<Pool, 'query' | 'connect'>,
  insideTransaction = false;
beforeAll(async () => {
  db = new PGlite();
  await db.waitReady;
  await db.exec(
    readFileSync(
      new URL('../../../../scripts/migrations/014-offchain-metadata-cache.sql', import.meta.url),
      'utf8'
    )
  );
  for (const name of ['021-token-descriptions.sql', '023-token-metadata-socials.sql'])
    await db.exec(
      readFileSync(new URL(`../../../../scripts/migrations/${name}`, import.meta.url), 'utf8')
    );
  let queue = Promise.resolve();
  const acquire = async () => {
    const previous = queue;
    let release!: () => void;
    queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  };
  const query = async (sql: string, args?: unknown[]) => {
    if (sql === 'BEGIN') insideTransaction = true;
    const result = await db.query(sql, args);
    if (sql === 'COMMIT' || sql === 'ROLLBACK') insideTransaction = false;
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };
  pool = {
    query: async (sql: string, args?: unknown[]) => {
      const release = await acquire();
      try {
        return await query(sql, args);
      } finally {
        release();
      }
    },
    connect: async () => {
      const release = await acquire();
      return { query, release };
    },
  } as unknown as Pick<Pool, 'query' | 'connect'>;
}, 20_000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec('TRUNCATE offchain_metadata_cache');
  fetch.mockReset();
  insideTransaction = false;
});
const expire = async (digest = key.digest) =>
  db.query(
    `UPDATE offchain_metadata_cache SET fetched_at=clock_timestamp()-interval '7 hours',refresh_at='epoch',retry_at='epoch' WHERE uri_digest=$1`,
    [digest]
  );
describe('durable display metadata leases', () => {
  it('persists artwork together with descriptions and social links across a restart', async () => {
    const store = new PostgresOffchainMetadataStore(pool);
    const value = {
      image,
      source: null as string | null,
      description: 'Fresh launch',
      website: 'https://www.youtube.com/watch?v=zdjo712qnyE',
      twitter: 'https://x.com/_bolivian',
    };
    const cache = new OffchainMetadataCache({ store });
    await cache.seed(uri, value);
    expect((await store.read(key))?.value).toEqual(value);
    const restarted = new OffchainMetadataCache({ store: new PostgresOffchainMetadataStore(pool) });
    expect(await restarted.get(uri)).toEqual(value);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('grants one cross-process lease and survives a process restart without downloading again', async () => {
    const a = new PostgresOffchainMetadataStore(pool),
      b = new PostgresOffchainMetadataStore(pool);
    const claims = await Promise.all([a.claim(key), b.claim(key)]);
    expect(claims.filter((value) => value.lease)).toHaveLength(1);
    const winner = claims.find((value) => value.lease)!.lease!;
    await a.complete(winner, { image, source: 'https://x.com/creator/status/12345' });
    expect((await new PostgresOffchainMetadataStore(pool).read(key))?.value.image).toBe(image);
    const restarted = new OffchainMetadataCache({ store: new PostgresOffchainMetadataStore(pool) });
    expect((await restarted.get(uri)).image).toBe(image);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reclaims a crashed lease after30seconds and rejects its late completion or failure', async () => {
    const store = new PostgresOffchainMetadataStore(pool),
      first = (await store.claim(key)).lease!;
    const lifetime = (
      await db.query<{ duration: number }>(
        `SELECT extract(epoch FROM lease_until-accessed_at)*1000 AS duration FROM offchain_metadata_cache`
      )
    ).rows[0]!.duration;
    expect(Number(lifetime)).toBeGreaterThan(29_999);
    expect(Number(lifetime)).toBeLessThanOrEqual(30_001);
    await db.query(
      `UPDATE offchain_metadata_cache SET lease_until=clock_timestamp()-interval '1 millisecond' WHERE uri_digest=$1`,
      [key.digest]
    );
    const second = (await new PostgresOffchainMetadataStore(pool).claim(key)).lease!;
    expect(second.token).not.toBe(first.token);
    expect(await store.renew(first)).toBe(false);
    expect(await store.complete(first, { image, source: null })).toBeNull();
    await store.fail(first);
    expect(await store.renew(second)).toBe(true);
    expect((await store.complete(second, { image, source: null }))?.value.image).toBe(image);
  });
  it('preserves stale artwork on failure and enforces a finite retry cooldown', async () => {
    const store = new PostgresOffchainMetadataStore(pool);
    await store.complete((await store.claim(key)).lease!, { image, source: null });
    await expire();
    const lease = (await store.claim(key)).lease!;
    await store.fail(lease);
    const next = await store.claim(key);
    expect(next.lease).toBeNull();
    expect(next.snapshot?.value.image).toBe(image);
    await db.query(
      `UPDATE offchain_metadata_cache SET retry_at=clock_timestamp()-interval '1 millisecond' WHERE uri_digest=$1`,
      [key.digest]
    );
    expect((await store.claim(key)).lease).not.toBeNull();
  });
  it('bounds persistent entries and never evicts an active fetch lease', async () => {
    const store = new PostgresOffchainMetadataStore(pool, 2),
      second = metadataKey(`${uri}/two`),
      third = metadataKey(`${uri}/three`);
    await store.claim(key);
    await store.claim(second);
    expect((await store.claim(third)).lease).toBeNull();
    expect(
      Number(
        (await db.query<{ count: string }>('SELECT count(*) AS count FROM offchain_metadata_cache'))
          .rows[0]!.count
      )
    ).toBe(2);
    await db.query(`UPDATE offchain_metadata_cache SET lease_until='epoch' WHERE uri_digest=$1`, [
      key.digest,
    ]);
    expect((await store.claim(third)).lease).not.toBeNull();
    expect(await store.read(key)).toBeNull();
    expect(await store.read(second)).not.toBeNull();
  });
  it('revalidates stored URLs and repairs poisoned schedules instead of retaining an empty image forever', async () => {
    const store = new PostgresOffchainMetadataStore(pool);
    await db.query(
      `INSERT INTO offchain_metadata_cache(uri_digest,uri,value,fetched_at,refresh_at) VALUES($1,$2,$3,'3000-01-01','3000-01-01')`,
      [
        key.digest,
        key.uri,
        JSON.stringify({ image: 'https://127.0.0.1/private', source: 'javascript:alert(1)' }),
      ]
    );
    expect((await store.read(key))?.value).toEqual({ image: null, source: null });
    const claimed = await store.claim(key);
    expect(claimed.lease).not.toBeNull();
    await store.complete(claimed.lease!, { image, source: null });
    await expect(
      db.query(`UPDATE offchain_metadata_cache SET value=$1::jsonb`, [
        JSON.stringify({ image, source: null, feeAuthority: 'untrusted' }),
      ])
    ).rejects.toThrow();
    await db.query(
      `UPDATE offchain_metadata_cache SET value='{"image":null,"source":null}',fetched_at='3000-01-01',refresh_at='3000-01-01'`
    );
    fetch.mockResolvedValue(Buffer.from(JSON.stringify({ image: uri })));
    expect((await new OffchainMetadataCache({ store }).get(uri)).image).toBe(image);
  });
  it('refuses insertion when restoring an oversized cache cannot evict enough active leases', async () => {
    const larger = new PostgresOffchainMetadataStore(pool, 4);
    const keys = [key, ...[1, 2, 3].map((index) => metadataKey(`${uri}/existing-${index}`))];
    for (const item of keys) await larger.claim(item);
    await db.query(`UPDATE offchain_metadata_cache SET lease_until='epoch' WHERE uri_digest=$1`, [
      key.digest,
    ]);
    const incoming = metadataKey(`${uri}/new-after-restore`),
      smaller = new PostgresOffchainMetadataStore(pool, 2);
    expect((await smaller.claim(incoming)).lease).toBeNull();
    expect(await smaller.read(incoming)).toBeNull();
    expect(
      Number(
        (await db.query<{ count: string }>('SELECT count(*) AS count FROM offchain_metadata_cache'))
          .rows[0]!.count
      )
    ).toBe(3);
    for (const item of keys.slice(1))
      expect((await smaller.read(item))?.leaseUntil).toBeGreaterThan(Date.now());
  });
  it('coalesces two processes and performs every network download outside SQL transactions', async () => {
    const a = new OffchainMetadataCache({ store: new PostgresOffchainMetadataStore(pool) }),
      b = new OffchainMetadataCache({ store: new PostgresOffchainMetadataStore(pool) });
    let finish!: (bytes: Buffer) => void;
    fetch.mockImplementation(() => {
      expect(insideTransaction).toBe(false);
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const pending = [a.get(uri), b.get(uri)];
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    finish(Buffer.from(JSON.stringify({ image: uri, source: null })));
    await Promise.all(pending);
    expect(
      (await new OffchainMetadataCache({ store: new PostgresOffchainMetadataStore(pool) }).get(uri))
        .image
    ).toBe(image);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('returns durable stale images immediately, then refreshes them in the background', async () => {
    const store = new PostgresOffchainMetadataStore(pool);
    await store.complete((await store.claim(key)).lease!, { image, source: null });
    await expire();
    const cache = new OffchainMetadataCache({ store });
    let finish!: (bytes: Buffer) => void;
    fetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    expect((await cache.get(uri)).image).toBe(image);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const newer = `${uri}/art.png`;
    finish(Buffer.from(JSON.stringify({ image: newer })));
    await vi.waitFor(async () =>
      expect((await store.read(key))?.value.image).toBe(metadataKey(newer).uri)
    );
    expect(
      (await new OffchainMetadataCache({ store: new PostgresOffchainMetadataStore(pool) }).get(uri))
        .image
    ).toBe(metadataKey(newer).uri);
  });
  it('bounds URI input before storage/network work', async () => {
    const cache = new OffchainMetadataCache({ store: new PostgresOffchainMetadataStore(pool) });
    expect(
      (await cache.get(`https://ipfs.io/ipfs/${'x'.repeat(METADATA_LIMITS.uriBytes)}`)).image
    ).toBeNull();
    expect((await cache.get('http://127.0.0.1/internal')).image).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect((await db.query('SELECT * FROM offchain_metadata_cache')).rows).toHaveLength(0);
  });
  it('keeps durable stale artwork after background failure and recovers after a restart/cooldown', async () => {
    const store = new PostgresOffchainMetadataStore(pool);
    await store.complete((await store.claim(key)).lease!, { image, source: null });
    await expire();
    fetch.mockRejectedValueOnce(new Error('Temporary gateway outage'));
    expect((await new OffchainMetadataCache({ store }).get(uri)).image).toBe(image);
    await vi.waitFor(async () =>
      expect((await store.read(key))!.retryAt).toBeGreaterThan(Date.now())
    );
    expect(
      (await new OffchainMetadataCache({ store: new PostgresOffchainMetadataStore(pool) }).get(uri))
        .image
    ).toBe(image);
    expect(fetch).toHaveBeenCalledTimes(1);
    await db.query(`UPDATE offchain_metadata_cache SET retry_at='epoch' WHERE uri_digest=$1`, [
      key.digest,
    ]);
    fetch.mockResolvedValue(Buffer.from(JSON.stringify({ image: `${uri}/recovered.png` })));
    await new OffchainMetadataCache({ store }).get(uri);
    await vi.waitFor(async () =>
      expect((await store.read(key))?.value.image).toContain('recovered.png')
    );
  });
  it('expires successful empty metadata so missing artwork can recover', async () => {
    const store = new PostgresOffchainMetadataStore(pool);
    const empty = await store.complete((await store.claim(key)).lease!, {
      image: null,
      source: null,
    });
    expect(empty!.refreshAt - empty!.fetchedAt!).toBeLessThanOrEqual(METADATA_LIMITS.retryMs + 1);
    await expire();
    fetch.mockResolvedValue(
      Buffer.from(JSON.stringify({ image: uri, feeAuthority: 'ignored-untrusted-field' }))
    );
    expect(await new OffchainMetadataCache({ store }).get(uri)).toEqual({ image, source: null });
    expect((await store.read(key))?.value).toEqual({ image, source: null });
  });
});
