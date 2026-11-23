import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { Keypair } from '@solana/web3.js';
import type { Pool } from 'pg';
import { consumeLaunchUpload } from './launchUploadBudget';

let db: PGlite;
let gate = Promise.resolve();
const pool = {
  async connect() {
    const previous = gate;
    let release!: () => void;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return {
      query: async (sql: string, args?: unknown[]) => {
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
        const result = await db.query(sql, args);
        return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
      },
      release,
    };
  },
} as unknown as Pick<Pool, 'connect'>;
const wallet = () => Keypair.generate().publicKey.toBase58();
const signature = (value: number) => Buffer.alloc(64, value).toString('base64');
beforeAll(async () => {
  db = new PGlite();
  await db.waitReady;
  await db.exec(
    readFileSync(
      new URL('../../../../scripts/migrations/015-launch-upload-budgets.sql', import.meta.url),
      'utf8'
    )
  );
});
beforeEach(async () => {
  await db.exec('TRUNCATE launch_upload_authorizations,launch_upload_budgets');
});
afterAll(async () => {
  await db.close();
});

describe('durable launch upload admission', () => {
  it('survives another process and collapses alternate base64 encodings of the same signature', async () => {
    const owner = wallet(),
      signed = signature(1);
    expect(await consumeLaunchUpload({ wallet: owner, signature: signed }, pool)).toEqual({
      allowed: true,
    });
    // Non-canonical padding bits decode to the identical Ed25519 signature bytes.
    const alias = signed.slice(0, -3) + 'R==';
    expect(Buffer.from(alias, 'base64')).toEqual(Buffer.from(signed, 'base64'));
    expect(await consumeLaunchUpload({ wallet: owner, signature: alias }, pool)).toEqual({
      allowed: false,
      reason: 'replayed',
    });
    expect((await db.query('SELECT attempts FROM launch_upload_budgets')).rows).toEqual([
      { attempts: 1 },
      { attempts: 1 },
    ]);
  });
  it('enforces a shared wallet budget and keeps denied signed attempts consumed', async () => {
    const owner = wallet();
    for (let i = 1; i <= 3; i++)
      expect(
        (await consumeLaunchUpload({ wallet: owner, signature: signature(i) }, pool)).allowed
      ).toBe(true);
    expect(await consumeLaunchUpload({ wallet: owner, signature: signature(4) }, pool)).toEqual({
      allowed: false,
      reason: 'limit',
    });
    await db.query("UPDATE launch_upload_budgets SET expires_at=now()-interval '1 second'");
    expect(await consumeLaunchUpload({ wallet: owner, signature: signature(4) }, pool)).toEqual({
      allowed: false,
      reason: 'replayed',
    });
    expect(
      (await consumeLaunchUpload({ wallet: owner, signature: signature(5) }, pool)).allowed
    ).toBe(true);
  });
  it('conserves the shared provider budget across concurrent callers and expires only old windows', async () => {
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        consumeLaunchUpload({ wallet: wallet(), signature: signature(i + 10) }, pool)
      )
    );
    expect(results.filter((value) => value.allowed)).toHaveLength(20);
    expect(results.filter((value) => 'reason' in value && value.reason === 'limit')).toHaveLength(
      4
    );
    expect(
      (
        await db.query<{ attempts: number }>(
          "SELECT attempts FROM launch_upload_budgets WHERE bucket='global'"
        )
      ).rows[0]?.attempts
    ).toBe(20);
    await db.exec(
      "UPDATE launch_upload_budgets SET expires_at=now()-interval '1 second'; UPDATE launch_upload_authorizations SET expires_at=now()-interval '1 second'"
    );
    expect(
      (await consumeLaunchUpload({ wallet: wallet(), signature: signature(100) }, pool)).allowed
    ).toBe(true);
    expect((await db.query('SELECT * FROM launch_upload_authorizations')).rows).toHaveLength(1);
  });
  it('bounds active replay evidence even when every caller has a fresh signature', async () => {
    const owner = wallet();
    await db.query(
      `INSERT INTO launch_upload_authorizations(authorization_digest,wallet)
      SELECT lpad(to_hex(value),64,'0'),$1 FROM generate_series(1,10000) AS value`,
      [owner]
    );
    expect(await consumeLaunchUpload({ wallet: owner, signature: signature(200) }, pool)).toEqual({
      allowed: false,
      reason: 'limit',
    });
    expect(
      (
        await db.query<{ total: number }>(
          'SELECT count(*)::integer AS total FROM launch_upload_authorizations'
        )
      ).rows[0]?.total
    ).toBe(10000);
  });
});
