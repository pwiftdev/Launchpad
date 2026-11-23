import { readFileSync } from 'node:fs';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { PublicKey, Keypair } from '@solana/web3.js';
import { PGlite } from '@electric-sql/pglite';
import type { Pool, PoolClient } from 'pg';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ProfileStore, profileDraft, calloutDraft } from './profileStore';
import { safeAvatarUrl } from '@/lib/profiles';

let db: PGlite, store: ProfileStore;
const origin = 'https://launch.example';
const genesis = Keypair.generate().publicKey.toBase58(),
  mint = Keypair.generate().publicKey.toBase58();
const user = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    wallet: new PublicKey(
      publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
    ).toBase58(),
    key: privateKey,
  };
};
const signature = (message: string, key: KeyObject) =>
  sign(null, Buffer.from(message), key).toString('base64');
const draft = { username: 'my_name', bio: 'Hello holders', avatarUrl: '' };
beforeAll(async () => {
  db = new PGlite();
  await db.waitReady;
  let queue = Promise.resolve();
  const query = async (sql: string, args?: unknown[]) => {
    const result = await db.query(sql, args);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };
  store = new ProfileStore({
    query,
    connect: async () => {
      const previous = queue;
      let release!: () => void;
      queue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      return { query, release } as unknown as PoolClient;
    },
  } as Pick<Pool, 'query' | 'connect'>);
}, 20_000);
beforeEach(async () => {
  await db.exec('DROP SCHEMA public CASCADE;CREATE SCHEMA public;');
  await db.exec(
    `CREATE TABLE launch_coins(network_genesis text,mint varchar(44),PRIMARY KEY(network_genesis,mint));`
  );
  const source = readFileSync(
    new URL('../../../../scripts/migrations/020-wallet-profiles.sql', import.meta.url),
    'utf8'
  );
  await db.exec(source);
  await db.exec(source);
  await db.query('INSERT INTO launch_coins VALUES($1,$2)', [genesis, mint]);
});
afterAll(async () => db.close());

describe('wallet profile and callout persistence', () => {
  it('requires the exact wallet signature, origin and action before saving', async () => {
    const alice = user(),
      mallory = user();
    const challenge = await store.challenge(alice.wallet, 'profile', origin, draft);
    await expect(
      store.submit(
        alice.wallet,
        'profile',
        origin,
        challenge.nonce,
        signature(challenge.message, mallory.key)
      )
    ).rejects.toThrow('signed request');
    await expect(
      store.submit(
        alice.wallet,
        'profile',
        'https://other.example',
        challenge.nonce,
        signature(challenge.message, alice.key)
      )
    ).rejects.toThrow('signed request');
    await expect(
      store.submit(
        alice.wallet,
        'callout',
        origin,
        challenge.nonce,
        signature(challenge.message, alice.key)
      )
    ).rejects.toThrow('signed request');
    expect(await store.profiles([alice.wallet])).toEqual([]);
    await store.submit(
      alice.wallet,
      'profile',
      origin,
      challenge.nonce,
      signature(challenge.message, alice.key)
    );
    expect((await store.profiles([alice.wallet]))[0]?.username).toBe('my_name');
  });
  it('serializes concurrent replay so one nonce mutates exactly once', async () => {
    const alice = user();
    const challenge = await store.challenge(alice.wallet, 'profile', origin, draft);
    const outcomes = await Promise.allSettled(
      [1, 2].map(() =>
        store.submit(
          alice.wallet,
          'profile',
          origin,
          challenge.nonce,
          signature(challenge.message, alice.key)
        )
      )
    );
    expect(outcomes.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect((await db.query('SELECT * FROM wallet_profiles')).rows).toHaveLength(1);
  });
  it('normalizes names and rejects a second wallet claiming an existing name', async () => {
    const alice = user(),
      bob = user();
    for (const [person, name] of [
      [alice, 'My_Name'],
      [bob, 'MY_NAME'],
    ] as const) {
      const challenge = await store.challenge(person.wallet, 'profile', origin, {
        ...draft,
        username: name,
      });
      const result = store.submit(
        person.wallet,
        'profile',
        origin,
        challenge.nonce,
        signature(challenge.message, person.key)
      );
      if (person === alice) await result;
      else await expect(result).rejects.toThrow('already taken');
    }
    expect(await store.profiles([alice.wallet, bob.wallet])).toHaveLength(1);
  });
  it('updates only the signing wallet and rejects expired challenges', async () => {
    const alice = user();
    const challenge = await store.challenge(alice.wallet, 'profile', origin, draft);
    await db.query(
      "UPDATE wallet_social_challenges SET expires_at=now()-interval '1 second' WHERE nonce=$1",
      [challenge.nonce]
    );
    await expect(
      store.submit(
        alice.wallet,
        'profile',
        origin,
        challenge.nonce,
        signature(challenge.message, alice.key)
      )
    ).rejects.toThrow('signed request');
    const fresh = await store.challenge(alice.wallet, 'profile', origin, {
      ...draft,
      bio: 'Updated bio',
    });
    await store.submit(
      alice.wallet,
      'profile',
      origin,
      fresh.nonce,
      signature(fresh.message, alice.key)
    );
    expect((await store.profiles([alice.wallet]))[0]?.bio).toBe('Updated bio');
  });
  it('binds callout content and mint, stores plain text and paginates by exact integer ID', async () => {
    const alice = user();
    const body = '<img src=x onerror=alert(1)> Good project?';
    const challenge = await store.challenge(alice.wallet, 'callout', origin, {
      networkGenesis: genesis,
      mint,
      body,
    });
    expect(challenge.message).toContain(mint);
    expect(challenge.message).toContain(body);
    await store.submit(
      alice.wallet,
      'callout',
      origin,
      challenge.nonce,
      signature(challenge.message, alice.key)
    );
    const rows = await store.callouts(genesis, mint, null);
    expect(rows[0]?.body).toBe(body);
    expect(await store.callouts(genesis, mint, rows[0]!.id)).toEqual([]);
    expect(await store.callouts(genesis, Keypair.generate().publicKey.toBase58(), null)).toEqual(
      []
    );
    await expect(
      store.submit(
        alice.wallet,
        'callout',
        origin,
        challenge.nonce,
        signature(challenge.message, alice.key)
      )
    ).rejects.toThrow();
  });
  it('rejects unknown tokens and enforces durable challenge and posting quotas', async () => {
    const alice = user();
    await expect(
      store.challenge(alice.wallet, 'callout', origin, {
        networkGenesis: genesis,
        mint: Keypair.generate().publicKey.toBase58(),
        body: 'Hello',
      })
    ).rejects.toThrow('not available');
    for (let i = 0; i < 10; i++) {
      const challenge = await store.challenge(alice.wallet, 'callout', origin, {
        networkGenesis: genesis,
        mint,
        body: `Callout ${i}`,
      });
      await store.submit(
        alice.wallet,
        'callout',
        origin,
        challenge.nonce,
        signature(challenge.message, alice.key)
      );
    }
    const challenge = await store.challenge(alice.wallet, 'callout', origin, {
      networkGenesis: genesis,
      mint,
      body: 'Extra',
    });
    await expect(
      store.submit(
        alice.wallet,
        'callout',
        origin,
        challenge.nonce,
        signature(challenge.message, alice.key)
      )
    ).rejects.toThrow('10 callouts');
    await expect(store.challenge(alice.wallet, 'profile', origin, draft)).rejects.toThrow(
      'Too many'
    );
  });
  it('rejects controls, oversize content, reserved names and unsupported avatar schemes', () => {
    for (const username of ['admin', 'RINSED', 'aa', '1_name', 'has space', 'x'.repeat(25)])
      expect(profileDraft.safeParse({ ...draft, username }).success).toBe(false);
    for (const bio of ['x'.repeat(281), 'invisible\u202eidentity', 'bad\u0000value'])
      expect(profileDraft.safeParse({ ...draft, bio }).success).toBe(false);
    for (const url of [
      'javascript:alert(1)',
      'data:image/svg+xml,test',
      'https://ipfs.io@evil.example/a',
      'https://127.0.0.1/a',
      'http://ipfs.io/a',
      'https://ipfs.io:444/a',
    ])
      expect(safeAvatarUrl(url)).toBe(false);
    expect(safeAvatarUrl('https://ipfs.io/ipfs/public-avatar')).toBe(true);
    expect(calloutDraft.safeParse({ networkGenesis: genesis, mint, body: '  ' }).success).toBe(
      false
    );
    expect(
      calloutDraft.safeParse({ networkGenesis: genesis, mint, body: 'x'.repeat(501) }).success
    ).toBe(false);
  });
});
