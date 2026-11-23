import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export type DammCheckpointIdentity = {
  networkGenesis: string;
  programId: string;
  mint: string;
  pool: string;
  position: string;
  classificationPolicy: 'q128-growth-v1';
};
export type UnsignedDammCheckpoint = DammCheckpointIdentity & {
  version: 1;
  cursorSignature: string;
  cursorSlot: number;
  cursorTransactionIndex: number;
  payload: Record<string, unknown>;
  previousCheckpointDigest: string | null;
  rollingHistoryDigest: string;
  verifiedSnapshotSlot: number;
  poolDigest: string;
  positionDigest: string;
};
export type StoredDammCheckpoint = UnsignedDammCheckpoint & {
  keyId: string;
  payloadDigest: string;
  digest: string;
  mac: string;
};
declare const checkpointBrand: unique symbol;
export type VerifiedDammCheckpoint = Readonly<StoredDammCheckpoint> & {
  readonly [checkpointBrand]: true;
};
const verified = new WeakSet<object>();
const HEX = /^[a-f0-9]{64}$/;
const DOMAIN = 'rinsed-damm-checkpoint-v1\0';
const fields = [
  'version',
  'networkGenesis',
  'programId',
  'mint',
  'pool',
  'position',
  'classificationPolicy',
  'cursorSignature',
  'cursorSlot',
  'cursorTransactionIndex',
  'payload',
  'previousCheckpointDigest',
  'rollingHistoryDigest',
  'verifiedSnapshotSlot',
  'poolDigest',
  'positionDigest',
] as const;
const identityFields = [
  'networkGenesis',
  'programId',
  'mint',
  'pool',
  'position',
  'classificationPolicy',
] as const;

/** Sorted JSON with no silent omission/coercion of non-JSON values or inherited objects. */
function canonical(value: unknown, depth = 0): string {
  if (depth > 64) throw new Error('Checkpoint JSON nesting exceeds capacity');
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Nonfinite checkpoint number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new Error('Sparse checkpoint array');
    return '[' + value.map((item) => canonical(item, depth + 1)).join(',') + ']';
  }
  if (typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      throw new Error('Checkpoint payload must be serialized JSON');
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ':' +
            canonical((value as Record<string, unknown>)[key], depth + 1)
        )
        .join(',') +
      '}'
    );
  }
  throw new Error('Checkpoint payload must contain only JSON values');
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function decodeKey(encoded: unknown): Buffer {
  if (
    typeof encoded !== 'string' ||
    !encoded ||
    encoded.length > 4096 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  )
    throw new Error(
      'Dedicated checkpoint HMAC key must be canonical base64 with at least 32 bytes'
    );
  const result = Buffer.from(encoded, 'base64');
  if (result.length < 32 || result.toString('base64') !== encoded)
    throw new Error(
      'Dedicated checkpoint HMAC key must be canonical base64 with at least 32 bytes'
    );
  return result;
}
function activeKeyId(): string {
  const id = process.env.FINANCIAL_CHECKPOINT_KEY_ID || 'primary';
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(id))
    throw new Error('Invalid checkpoint signing key identifier');
  return id;
}
function keys() {
  const id = activeKeyId();
  const serialized = process.env.FINANCIAL_CHECKPOINT_VERIFY_KEYS_JSON || '{}';
  if (serialized.length > 64 * 1024)
    throw new Error('Checkpoint verification keyring exceeds capacity');
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error('Invalid checkpoint verification keyring JSON');
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object')
    throw new Error('Invalid checkpoint verification keyring');
  const ring = new Map<string, Buffer>();
  for (const [name, encoded] of Object.entries(parsed)) {
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name))
      throw new Error('Invalid checkpoint verification key identifier');
    ring.set(name, decodeKey(encoded));
  }
  const active = process.env.FINANCIAL_CHECKPOINT_HMAC_KEY
    ? decodeKey(process.env.FINANCIAL_CHECKPOINT_HMAC_KEY)
    : undefined;
  if (active)
    for (const other of [process.env.WHITELIST_SECRET, process.env.ADMIN_SESSION_SECRET].filter(
      (value): value is string => !!value
    ))
      if (other === process.env.FINANCIAL_CHECKPOINT_HMAC_KEY || active.equals(Buffer.from(other)))
        throw new Error('Checkpoint authentication must use an independent operator secret');
  const retained = ring.get(id);
  if (
    active &&
    retained &&
    !timingSafeEqual(
      createHash('sha256').update(active).digest(),
      createHash('sha256').update(retained).digest()
    )
  )
    throw new Error('Checkpoint key identifier maps to conflicting secrets');
  if (active) ring.set(id, active);
  return { id, active, ring };
}
/** Call before planning or checkpoint writes, rather than discovering a bad key after settlement. */
export function assertCheckpointSigningConfigured(): void {
  if (!keys().active) throw new Error('Dedicated checkpoint HMAC signing key is not configured');
}
function unsigned(input: UnsignedDammCheckpoint): UnsignedDammCheckpoint {
  if (input.version !== 1 || input.classificationPolicy !== 'q128-growth-v1')
    throw new Error('Unsupported checkpoint version/policy');
  for (const field of identityFields) {
    if (typeof input[field] !== 'string' || input[field].length < 1 || input[field].length > 128)
      throw new Error('Invalid checkpoint identity');
  }
  if (
    !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(input.cursorSignature) ||
    !Number.isSafeInteger(input.cursorSlot) ||
    input.cursorSlot < 0 ||
    !Number.isSafeInteger(input.cursorTransactionIndex) ||
    input.cursorTransactionIndex < 0 ||
    !Number.isSafeInteger(input.verifiedSnapshotSlot) ||
    input.verifiedSnapshotSlot < input.cursorSlot
  )
    throw new Error('Invalid checkpoint cursor/snapshot');
  if (
    !HEX.test(input.rollingHistoryDigest) ||
    !HEX.test(input.poolDigest) ||
    !HEX.test(input.positionDigest) ||
    (input.previousCheckpointDigest !== null && !HEX.test(input.previousCheckpointDigest))
  )
    throw new Error('Invalid checkpoint evidence digest');
  if (!input.payload || Array.isArray(input.payload) || typeof input.payload !== 'object')
    throw new Error('Checkpoint payload must be a JSON object');
  const selected = Object.fromEntries(
    fields.map((field) => [field, input[field]])
  ) as UnsignedDammCheckpoint;
  const serialized = canonical(selected);
  if (Buffer.byteLength(serialized) > 16 * 1024 * 1024)
    throw new Error('Checkpoint JSON exceeds capacity');
  // Clone through the canonical representation so callers cannot mutate nested verified state.
  return JSON.parse(serialized) as UnsignedDammCheckpoint;
}
function branded(input: StoredDammCheckpoint): VerifiedDammCheckpoint {
  const freeze = (value: unknown): void => {
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  };
  freeze(input);
  verified.add(input);
  return input as VerifiedDammCheckpoint;
}
function authenticate(
  input: UnsignedDammCheckpoint,
  keyId: string,
  secret: Buffer
): VerifiedDammCheckpoint {
  const body = unsigned(input),
    payloadDigest = sha(canonical(body.payload));
  const digest = sha(canonical({ ...body, keyId, payloadDigest }));
  const mac = createHmac('sha256', secret)
    .update(DOMAIN)
    .update(Buffer.from(digest, 'hex'))
    .digest('hex');
  return branded({ ...body, keyId, payloadDigest, digest, mac });
}
export function sealDammCheckpoint(input: UnsignedDammCheckpoint): VerifiedDammCheckpoint {
  const configuration = keys();
  if (!configuration.active)
    throw new Error('Dedicated checkpoint HMAC signing key is not configured');
  return authenticate(input, configuration.id, configuration.active);
}
export function verifyDammCheckpoint(
  input: StoredDammCheckpoint,
  expected: DammCheckpointIdentity
): VerifiedDammCheckpoint {
  for (const field of identityFields)
    if (input[field] !== expected[field]) throw new Error('Checkpoint identity mismatch');
  if (!HEX.test(input.digest) || !HEX.test(input.mac) || !HEX.test(input.payloadDigest))
    throw new Error('Invalid checkpoint authentication');
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(input.keyId))
    throw new Error('Invalid checkpoint key identifier');
  const secret = keys().ring.get(input.keyId);
  if (!secret)
    throw new Error('Checkpoint verification key is unavailable; retain prior keyring entries');
  const recomputed = authenticate(input, input.keyId, secret);
  if (
    input.payloadDigest !== recomputed.payloadDigest ||
    input.digest !== recomputed.digest ||
    !timingSafeEqual(Buffer.from(input.mac, 'hex'), Buffer.from(recomputed.mac, 'hex'))
  )
    throw new Error('Checkpoint authentication failed');
  return recomputed;
}
export function assertVerifiedDammCheckpoint(input: VerifiedDammCheckpoint): void {
  if (!verified.has(input)) throw new Error('MAC-verified immutable checkpoint required');
}
