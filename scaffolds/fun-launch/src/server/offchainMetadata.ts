import { fetchRemote } from './remote';
import {
  EMPTY_METADATA,
  METADATA_LIMITS,
  metadataKey,
  sanitizeMetadata,
  type MetadataKey,
  type OffchainMetadata,
} from './offchainMetadataValue';
import type {
  MetadataLease,
  MetadataSnapshot,
  OffchainMetadataStore,
} from './offchainMetadataStore';
export type { OffchainMetadata } from './offchainMetadataValue';
type Entry = {
  value: OffchainMetadata;
  retryAt: number;
  pending?: Promise<OffchainMetadata>;
  hydrated?: boolean;
  hydrating?: Promise<void>;
};
type Options = { store?: OffchainMetadataStore | null; now?: () => number; maxEntries?: number };

/** Safe display-only stale data remains usable while a leased background refresh runs. */
export class OffchainMetadataCache {
  private entries = new Map<string, Entry>();
  private active = 0;
  private waiting: Array<() => void> = [];
  private readonly now: () => number;
  private readonly maxEntries: number;
  constructor(private readonly options: Options = {}) {
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? METADATA_LIMITS.entries;
    if (
      !Number.isInteger(this.maxEntries) ||
      this.maxEntries < 1 ||
      this.maxEntries > METADATA_LIMITS.entries
    )
      throw new Error('Invalid metadata cache capacity');
  }
  /** Uploads already know the metadata; avoid a gateway round trip for our own new launches. */
  async seed(uri: string, metadata: unknown): Promise<void> {
    const key = metadataKey(uri),
      value = sanitizeMetadata(metadata);
    if (this.entries.size >= this.maxEntries && !this.entries.has(key.digest)) {
      const oldest = [...this.entries].find(([, entry]) => !entry.pending && !entry.hydrating)?.[0];
      if (!oldest) return;
      this.entries.delete(oldest);
    }
    this.entries.set(key.digest, {
      value,
      retryAt: this.now() + METADATA_LIMITS.refreshMs,
      hydrated: true,
    });
    if (this.options.store) {
      const claimed = await this.options.store.claim(key);
      if (claimed.lease) await this.options.store.complete(claimed.lease, value);
    }
  }
  async get(uri: string): Promise<OffchainMetadata> {
    let key: MetadataKey;
    try {
      key = metadataKey(uri);
    } catch {
      return EMPTY_METADATA;
    }
    let entry = this.entries.get(key.digest);
    if (entry?.pending)
      return entry.value.image || entry.value.source ? entry.value : entry.pending;
    if (entry && this.now() < entry.retryAt) return entry.value;
    if (!entry) {
      if (this.entries.size >= this.maxEntries) {
        const oldest = [...this.entries].find(
          ([, value]) => !value.pending && !value.hydrating
        )?.[0];
        if (!oldest) return EMPTY_METADATA;
        this.entries.delete(oldest);
      }
      entry = { value: EMPTY_METADATA, retryAt: 0 };
      this.entries.set(key.digest, entry);
    } else {
      this.entries.delete(key.digest);
      this.entries.set(key.digest, entry);
    }
    if (this.options.store && !entry.hydrated) {
      if (
        !entry.hydrating &&
        this.active >= METADATA_LIMITS.concurrent &&
        this.waiting.length >= METADATA_LIMITS.pending
      ) {
        entry.retryAt = this.now() + METADATA_LIMITS.retryMs;
        return entry.value;
      }
      const current = entry;
      current.hydrating ??= this.execute(async () => {
        try {
          const cached = await this.options.store!.read(key);
          if (cached) this.adopt(current, cached);
        } catch {
          current.retryAt = this.now() + METADATA_LIMITS.retryMs;
        } finally {
          current.hydrated = true;
        }
      });
      await current.hydrating;
      current.hydrating = undefined;
      if (current.pending)
        return current.value.image || current.value.source ? current.value : current.pending;
      if (this.now() < current.retryAt) return current.value;
    }
    if (
      this.active >= METADATA_LIMITS.concurrent &&
      this.waiting.length >= METADATA_LIMITS.pending
    ) {
      entry.retryAt = this.now() + METADATA_LIMITS.retryMs;
      return entry.value;
    }
    const current = entry;
    current.pending = this.execute(() => this.refresh(key, current)).finally(() => {
      current.pending = undefined;
    });
    return current.value.image || current.value.source ? current.value : current.pending;
  }
  private async execute<T>(job: () => Promise<T>) {
    if (this.active >= METADATA_LIMITS.concurrent)
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      return await job();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
  private adopt(entry: Entry, snapshot: MetadataSnapshot) {
    entry.value = sanitizeMetadata(snapshot.value);
    const now = this.now(),
      ttl = entry.value.image ? METADATA_LIMITS.refreshMs : METADATA_LIMITS.retryMs;
    const fetched =
      typeof snapshot.fetchedAt === 'number' && Number.isFinite(snapshot.fetchedAt)
        ? Math.min(snapshot.fetchedAt, now)
        : 0;
    const fresh = Number.isFinite(snapshot.refreshAt)
      ? Math.min(snapshot.refreshAt, fetched + ttl)
      : 0;
    const retry = Number.isFinite(snapshot.retryAt)
      ? Math.min(snapshot.retryAt, now + METADATA_LIMITS.retryMs)
      : 0;
    const lease =
      typeof snapshot.leaseUntil === 'number' && Number.isFinite(snapshot.leaseUntil)
        ? Math.min(snapshot.leaseUntil, now + METADATA_LIMITS.leaseMs)
        : 0;
    entry.retryAt = Math.max(fresh, retry, lease);
  }
  private async refresh(key: MetadataKey, entry: Entry): Promise<OffchainMetadata> {
    const store = this.options.store;
    let lease: MetadataLease | undefined,
      timer: ReturnType<typeof setInterval> | undefined,
      renewing = false;
    try {
      if (store) {
        const cached = await store.read(key);
        if (cached) this.adopt(entry, cached);
        if (cached && this.now() < entry.retryAt) return entry.value;
        const claimed = await store.claim(key);
        if (claimed.snapshot) this.adopt(entry, claimed.snapshot);
        if (!claimed.lease) {
          entry.retryAt = Math.max(entry.retryAt, this.now() + METADATA_LIMITS.retryMs);
          return entry.value;
        }
        lease = claimed.lease;
        timer = setInterval(() => {
          if (renewing) return;
          renewing = true;
          void store
            .renew(lease!)
            .catch(() => false)
            .finally(() => {
              renewing = false;
            });
        }, METADATA_LIMITS.leaseMs / 3);
        timer.unref?.();
      }
      const value = sanitizeMetadata(
        JSON.parse((await fetchRemote(key.uri, 64 * 1024)).toString('utf8'))
      );
      if (!value.image && entry.value.image) throw new Error('Artwork temporarily unavailable');
      if (store && lease) {
        const saved = await store.complete(lease, value);
        if (saved) this.adopt(entry, saved);
        else {
          const winner = await store.read(key);
          if (winner) this.adopt(entry, winner);
          entry.retryAt = Math.max(entry.retryAt, this.now() + METADATA_LIMITS.retryMs);
        }
      } else {
        entry.value = value;
        entry.retryAt =
          this.now() + (value.image ? METADATA_LIMITS.refreshMs : METADATA_LIMITS.retryMs);
      }
      return entry.value;
    } catch {
      if (store && lease) await store.fail(lease).catch(() => {});
      entry.retryAt = this.now() + METADATA_LIMITS.retryMs;
      return entry.value;
    } finally {
      if (timer) clearInterval(timer);
    }
  }
}
