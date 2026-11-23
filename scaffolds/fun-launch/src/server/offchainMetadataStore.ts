import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { database } from './database';
import {
  METADATA_LIMITS,
  metadataKey,
  sanitizeMetadata,
  type MetadataKey,
  type OffchainMetadata,
} from './offchainMetadataValue';

export type MetadataSnapshot = {
  value: OffchainMetadata;
  fetchedAt: number | null;
  refreshAt: number;
  retryAt: number;
  leaseUntil: number | null;
};
export type MetadataLease = { key: MetadataKey; token: string };
export interface OffchainMetadataStore {
  read(key: MetadataKey): Promise<MetadataSnapshot | null>;
  claim(
    key: MetadataKey
  ): Promise<{ snapshot: MetadataSnapshot | null; lease: MetadataLease | null }>;
  renew(lease: MetadataLease): Promise<boolean>;
  complete(lease: MetadataLease, value: OffchainMetadata): Promise<MetadataSnapshot | null>;
  fail(lease: MetadataLease): Promise<void>;
}
type Row = {
  uri: string;
  value: unknown;
  fetched_at: Date | string | null;
  refresh_at: Date | string;
  retry_at: Date | string;
  lease_until: Date | string | null;
  database_now: Date | string;
};
const fields =
  'uri,value,fetched_at,refresh_at,retry_at,lease_until,clock_timestamp() AS database_now';
const time = (value: Date | string) => new Date(value).getTime();
function checkedKey(key: MetadataKey) {
  const checked = metadataKey(key.uri);
  if (checked.digest !== key.digest || checked.uri !== key.uri)
    throw new Error('Metadata key mismatch');
}
function snapshot(row: Row, key: MetadataKey): MetadataSnapshot {
  if (row.uri !== key.uri) throw new Error('Metadata cache URI digest collision');
  return {
    value: sanitizeMetadata(row.value),
    fetchedAt: row.fetched_at === null ? null : time(row.fetched_at),
    refreshAt: time(row.refresh_at),
    retryAt: time(row.retry_at),
    leaseUntil: row.lease_until === null ? null : time(row.lease_until),
  };
}
function damaged(row: Row, safe: MetadataSnapshot) {
  const now = time(row.database_now),
    ttl = safe.value.image ? METADATA_LIMITS.refreshMs : METADATA_LIMITS.retryMs,
    stored = row.value as Record<string, unknown>,
    fields = Object.entries(safe.value);
  return (
    !Number.isFinite(now) ||
    [
      safe.refreshAt,
      safe.retryAt,
      ...(safe.fetchedAt === null ? [] : [safe.fetchedAt]),
      ...(safe.leaseUntil === null ? [] : [safe.leaseUntil]),
    ].some((value) => !Number.isFinite(value)) ||
    Object.keys(stored).length !== fields.length ||
    fields.some(([key, value]) => stored[key] !== value) ||
    (safe.fetchedAt === null
      ? safe.refreshAt > now
      : safe.fetchedAt > now + 60_000 || safe.refreshAt > safe.fetchedAt + ttl + 60_000) ||
    safe.retryAt > now + METADATA_LIMITS.retryMs + 60_000 ||
    (safe.leaseUntil !== null && safe.leaseUntil > now + METADATA_LIMITS.leaseMs + 60_000)
  );
}

/** Short SQL transactions coordinate fetch ownership. Downloads always run after COMMIT. */
export class PostgresOffchainMetadataStore implements OffchainMetadataStore {
  constructor(
    private readonly supplied?: Pick<Pool, 'query' | 'connect'>,
    private readonly maxEntries: number = METADATA_LIMITS.entries
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > METADATA_LIMITS.entries)
      throw new Error('Invalid metadata cache capacity');
  }
  private get db() {
    return this.supplied ?? database();
  }
  async read(key: MetadataKey) {
    checkedKey(key);
    const row = (
      await this.db.query<Row>(
        `UPDATE offchain_metadata_cache SET accessed_at=clock_timestamp() WHERE uri_digest=$1 RETURNING ${fields}`,
        [key.digest]
      )
    ).rows[0];
    if (!row) return null;
    const safe = snapshot(row, key);
    return damaged(row, safe) ? { ...safe, refreshAt: 0, retryAt: 0, leaseUntil: null } : safe;
  }
  async claim(key: MetadataKey) {
    checkedKey(key);
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('rinsed-offchain-metadata-capacity'))"
      );
      let row = (
        await client.query<Row>(
          `SELECT ${fields} FROM offchain_metadata_cache WHERE uri_digest=$1 FOR UPDATE`,
          [key.digest]
        )
      ).rows[0];
      if (!row) {
        const count = Number(
          (
            await client.query<{ count: string }>(
              'SELECT count(*) AS count FROM offchain_metadata_cache'
            )
          ).rows[0]!.count
        );
        if (count >= this.maxEntries) {
          const evicted = await client.query(
            `DELETE FROM offchain_metadata_cache WHERE uri_digest IN(SELECT uri_digest FROM offchain_metadata_cache WHERE lease_until IS NULL OR lease_until<=clock_timestamp() ORDER BY accessed_at,uri_digest LIMIT $1) RETURNING uri_digest`,
            [count - this.maxEntries + 1]
          );
          if (evicted.rows.length < count - this.maxEntries + 1) {
            await client.query('COMMIT');
            return { snapshot: null, lease: null };
          }
        }
        row = (
          await client.query<Row>(
            `INSERT INTO offchain_metadata_cache(uri_digest,uri) VALUES($1,$2) RETURNING ${fields}`,
            [key.digest, key.uri]
          )
        ).rows[0]!;
      }
      let safe = snapshot(row, key);
      if (damaged(row, safe))
        row = (
          await client.query<Row>(
            `UPDATE offchain_metadata_cache SET value=$2::jsonb,fetched_at=NULL,refresh_at='epoch',retry_at='epoch',lease_owner=NULL,lease_until=NULL WHERE uri_digest=$1 RETURNING ${fields}`,
            [key.digest, JSON.stringify(safe.value)]
          )
        ).rows[0]!;
      safe = snapshot(row, key);
      const now = time(row.database_now);
      if (
        (safe.leaseUntil !== null && safe.leaseUntil > now) ||
        Math.max(safe.refreshAt, safe.retryAt) > now
      ) {
        await client.query('COMMIT');
        return { snapshot: safe, lease: null };
      }
      const token = randomUUID();
      const leased = (
        await client.query<Row>(
          `UPDATE offchain_metadata_cache SET lease_owner=$2,lease_until=clock_timestamp()+interval '30 seconds',accessed_at=clock_timestamp() WHERE uri_digest=$1 RETURNING ${fields}`,
          [key.digest, token]
        )
      ).rows[0]!;
      await client.query('COMMIT');
      return { snapshot: snapshot(leased, key), lease: { key, token } };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async renew(lease: MetadataLease) {
    checkedKey(lease.key);
    return (
      (
        await this.db.query(
          `UPDATE offchain_metadata_cache SET lease_until=clock_timestamp()+interval '30 seconds' WHERE uri_digest=$1 AND uri=$2 AND lease_owner=$3 AND lease_until>clock_timestamp() RETURNING uri_digest`,
          [lease.key.digest, lease.key.uri, lease.token]
        )
      ).rows.length === 1
    );
  }
  async complete(lease: MetadataLease, value: OffchainMetadata) {
    checkedKey(lease.key);
    const safe = sanitizeMetadata(value),
      ttl = safe.image ? METADATA_LIMITS.refreshMs : METADATA_LIMITS.retryMs;
    const row = (
      await this.db.query<Row>(
        `UPDATE offchain_metadata_cache SET value=$4::jsonb,fetched_at=clock_timestamp(),refresh_at=clock_timestamp()+($5::bigint*interval '1 millisecond'),retry_at='epoch',lease_owner=NULL,lease_until=NULL,accessed_at=clock_timestamp() WHERE uri_digest=$1 AND uri=$2 AND lease_owner=$3 AND lease_until>clock_timestamp() RETURNING ${fields}`,
        [lease.key.digest, lease.key.uri, lease.token, JSON.stringify(safe), ttl]
      )
    ).rows[0];
    return row ? snapshot(row, lease.key) : null;
  }
  async fail(lease: MetadataLease) {
    checkedKey(lease.key);
    await this.db.query(
      `UPDATE offchain_metadata_cache SET retry_at=clock_timestamp()+interval '30 seconds',lease_owner=NULL,lease_until=NULL WHERE uri_digest=$1 AND uri=$2 AND lease_owner=$3`,
      [lease.key.digest, lease.key.uri, lease.token]
    );
  }
}
export function metadataStoreFromEnvironment(): OffchainMetadataStore | null {
  return process.env.DATABASE_URL ? new PostgresOffchainMetadataStore() : null;
}
