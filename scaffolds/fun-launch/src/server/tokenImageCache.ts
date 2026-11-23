import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { Pool } from 'pg';
import { database } from './database';
import { metadataKey, type MetadataKey } from './offchainMetadataValue';
import { fetchRemote } from './remote';

const MAX_ROWS = 1000;
const MAX_MEMORY_BYTES = 16 * 1024 * 1024;
export type TokenArtwork = { bytes: Buffer; etag: string };
const artwork = (bytes: Buffer): TokenArtwork => ({
  bytes,
  etag: `"${createHash('sha256').update(bytes).digest('hex')}"`,
});

/** Only decoded static artwork from allowlisted metadata destinations enters this cache. */
export class TokenImageCache {
  private memory = new Map<string, TokenArtwork>();
  private pending = new Map<string, Promise<TokenArtwork>>();
  private memoryBytes = 0;
  constructor(
    private readonly supplied?: Pick<Pool, 'query' | 'connect'>,
    private readonly download = fetchRemote
  ) {}
  private get db() {
    return this.supplied ?? database();
  }
  async seed(uri: string, source: Buffer): Promise<void> {
    if (!source.length || source.length > 2 * 1024 * 1024)
      throw new Error('Token artwork too large');
    await this.load(metadataKey(uri), source);
  }
  async get(uri: string): Promise<TokenArtwork> {
    const key = metadataKey(uri);
    const existing = this.memory.get(key.digest);
    if (existing) {
      this.memory.delete(key.digest);
      this.memory.set(key.digest, existing);
      return existing;
    }
    let work = this.pending.get(key.digest);
    if (!work) {
      if (this.pending.size >= 24) throw new Error('Artwork queue full');
      work = this.load(key).finally(() => this.pending.delete(key.digest));
      this.pending.set(key.digest, work);
    }
    return work;
  }
  private async load(key: MetadataKey, suppliedSource?: Buffer): Promise<TokenArtwork> {
    let bytes: Buffer | undefined;
    try {
      const row = (
        await this.db.query<{ uri: string; image: Buffer }>(
          'UPDATE token_image_cache SET accessed_at=clock_timestamp() WHERE uri_digest=$1 RETURNING uri,image',
          [key.digest]
        )
      ).rows[0];
      if (row?.uri === key.uri && Buffer.isBuffer(row.image) && row.image.length <= 524288)
        bytes = row.image;
    } catch {
      // A display cache outage still permits a bounded direct download.
    }
    if (!bytes) {
      const source = suppliedSource ?? (await this.download(key.uri, 2 * 1024 * 1024));
      const image = sharp(source, { limitInputPixels: 16_777_216, animated: false });
      const metadata = await image.metadata();
      if (!['png', 'jpeg', 'gif', 'webp', 'avif'].includes(metadata.format ?? ''))
        throw new Error('Unsupported token artwork');
      bytes = await image
        .rotate()
        .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 85 })
        .toBuffer();
      if (!bytes.length || bytes.length > 524288) throw new Error('Token artwork too large');
      await this.persist(key, bytes).catch(() => {});
    }
    const value = artwork(bytes);
    const previous = this.memory.get(key.digest);
    if (previous) {
      this.memoryBytes -= previous.bytes.length;
      this.memory.delete(key.digest);
    }
    while (
      this.memory.size &&
      (this.memoryBytes + bytes.length > MAX_MEMORY_BYTES || this.memory.size >= 128)
    ) {
      const oldest = this.memory.keys().next().value!;
      this.memoryBytes -= this.memory.get(oldest)!.bytes.length;
      this.memory.delete(oldest);
    }
    this.memory.set(key.digest, value);
    this.memoryBytes += bytes.length;
    return value;
  }
  private async persist(key: MetadataKey, bytes: Buffer) {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('rinsed-token-image-capacity'))");
      await client.query(
        `DELETE FROM token_image_cache WHERE uri_digest IN (
          SELECT uri_digest FROM token_image_cache WHERE uri_digest<>$1 ORDER BY accessed_at,uri_digest
          LIMIT GREATEST(0,(SELECT count(*) FROM token_image_cache)-$2+1))`,
        [key.digest, MAX_ROWS]
      );
      await client.query(
        'INSERT INTO token_image_cache(uri_digest,uri,image) VALUES($1,$2,$3) ON CONFLICT(uri_digest) DO NOTHING',
        [key.digest, key.uri, bytes]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export const tokenImages = new TokenImageCache();
