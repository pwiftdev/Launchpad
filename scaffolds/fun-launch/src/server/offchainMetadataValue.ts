import { createHash } from 'node:crypto';
import { imageSources } from '@/lib/ipfs';
import { remoteUrl } from './remote';
import { isSourcePostUrl, normalizeSocial, SOCIAL_KINDS, type Socials } from '@/lib/socials';

export type OffchainMetadata = {
  image: string | null;
  source: string | null;
  description?: string;
} & Socials;
export const METADATA_LIMITS = Object.freeze({
  entries: 5000,
  uriBytes: 2048,
  valueBytes: 2048,
  refreshMs: 6 * 60 * 60 * 1000,
  retryMs: 30_000,
  leaseMs: 30_000,
  pending: 64,
  concurrent: 6,
});
export const EMPTY_METADATA: OffchainMetadata = Object.freeze({ image: null, source: null });
export type MetadataKey = { uri: string; digest: string };
export function metadataKey(input: string): MetadataKey {
  if (typeof input !== 'string' || Buffer.byteLength(input) > METADATA_LIMITS.uriBytes)
    throw new Error('Invalid metadata URI');
  const candidate = imageSources(input)[0];
  if (!candidate) throw new Error('Missing metadata URI');
  const uri = remoteUrl(candidate).href;
  if (Buffer.byteLength(uri) > METADATA_LIMITS.uriBytes)
    throw new Error('Metadata URI exceeds capacity');
  return { uri, digest: createHash('sha256').update(uri).digest('hex') };
}
/** Only these display fields survive either an untrusted download or a database read. */
export function sanitizeMetadata(input: unknown): OffchainMetadata {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid token metadata');
  const fields = input as Record<string, unknown>;
  let image: string | null = null;
  if (
    typeof fields.image === 'string' &&
    Buffer.byteLength(fields.image) <= METADATA_LIMITS.valueBytes
  ) {
    try {
      image = metadataKey(fields.image).uri;
    } catch {
      /* Unsafe image links never enter the UI. */
    }
  }
  const source =
    typeof fields.source === 'string' &&
    Buffer.byteLength(fields.source) <= METADATA_LIMITS.valueBytes &&
    isSourcePostUrl(fields.source)
      ? fields.source
      : null;
  const description =
    typeof fields.description === 'string' && Buffer.byteLength(fields.description) <= 4000
      ? fields.description
          .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
          .trim()
          .slice(0, 1000)
      : '';
  // Our own launches write links top-level; other tools only use the `extensions` convention.
  const extensions =
    fields.extensions && typeof fields.extensions === 'object' && !Array.isArray(fields.extensions)
      ? (fields.extensions as Record<string, unknown>)
      : {};
  const socials: Socials = {};
  for (const kind of SOCIAL_KINDS) {
    const link = normalizeSocial(kind, fields[kind]) ?? normalizeSocial(kind, extensions[kind]);
    if (link) socials[kind] = link;
  }
  return Object.freeze({ image, source, ...(description ? { description } : {}), ...socials });
}
