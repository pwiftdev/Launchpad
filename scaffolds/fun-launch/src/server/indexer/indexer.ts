// The display indexer: one process keeps the board, trades and holders current in Postgres.
// Pool accounts are watched over the RPC websocket; a change marks the coin dirty, and a short
// loop refreshes its state, reads its new swaps and later rescans its holders. A slower sweep
// rediscovers coins and catches anything a dropped subscription missed.
import { PublicKey, type Connection, type PerfSample } from '@solana/web3.js';
import type { Coin } from '@/lib/coin';
import type { DisplayStore } from './store';
import { scanPool, type ScanRpc } from './scan';
import { scanHolders, type HolderRpc } from './holders';
import { readDisplayClock } from '../displayClock';

export type IndexerRpc = ScanRpc &
  HolderRpc &
  Pick<
    Connection,
    | 'onAccountChange'
    | 'removeAccountChangeListener'
    | 'getAccountInfo'
    | 'getRecentPerformanceSamples'
  >;

export type IndexerDeps = {
  rpc: IndexerRpc;
  store: DisplayStore;
  /** Every discoverable coin, read fresh from chain. */
  listCoins: () => Promise<Coin[]>;
  /** One coin's current display state, read fresh from chain; null when it is gone. */
  loadCoin: (mint: string) => Promise<Coin | null>;
  /** Token accounts that are not holders: pool vaults and fee custody. */
  holderExclusions: (coin: Coin) => Promise<string[]>;
  timing?: Partial<typeof TIMING>;
  log?: (message: string) => void;
};

const TIMING = {
  /** How often new or changed coins are processed. */
  dirtyMs: 2000,
  minimumRefreshMs: 15_000,
  /** Rediscovery of coins and a state comparison for every one. */
  discoverMs: 60_000,
  /** Every coin's history is re-read this often in case a notification was lost. */
  sweepMs: 5 * 60_000,
  holdersEveryMs: 60 * 60_000,
  holderTickMs: 5000,
  holderScansPerTick: 2,
  heartbeatMs: 60_000,
  concurrency: 4,
};

export class DisplayIndexer {
  private coins = new Map<string, Coin>();
  private subscriptions = new Map<string, number>();
  private dirty = new Set<string>();
  private busy = new Set<string>();
  private lastRefresh = new Map<string, number>();
  /** Backoff for coins whose refresh failed, so an outage never becomes a hot loop. */
  private failures = new Map<string, { count: number; retryAt: number }>();
  private holdersDue = new Map<string, number>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private lastSweep = 0;
  private stopped = false;
  private readonly t: typeof TIMING;
  private readonly log: (message: string) => void;

  constructor(private deps: IndexerDeps) {
    this.t = { ...TIMING, ...deps.timing };
    this.log = deps.log ?? ((message) => console.info(`[display-indexer] ${message}`));
  }

  async start() {
    await this.discover();
    if (this.stopped) return;
    const every = (ms: number, task: () => Promise<unknown>) => {
      let running = false;
      const timer = setInterval(() => {
        if (running || this.stopped) return;
        running = true;
        task()
          .catch(() => this.log('task failed; retrying on the next interval'))
          .finally(() => {
            running = false;
          });
      }, ms);
      timer.unref?.();
      this.timers.push(timer);
    };
    every(this.t.dirtyMs, () => this.processDirty());
    every(this.t.discoverMs, () => this.discover());
    every(this.t.holderTickMs, () => this.processHolders());
    every(this.t.heartbeatMs, () => this.heartbeat());
    await this.heartbeat().catch(() => {});
  }

  async stop() {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    await Promise.all(
      [...this.subscriptions.values()].map((id) =>
        this.deps.rpc.removeAccountChangeListener(id).catch(() => {})
      )
    );
    this.subscriptions.clear();
  }

  /** Marks a coin for an immediate refresh, e.g. right after a launch is registered. */
  touch(mint: string) {
    this.dirty.add(mint);
  }

  /** Coins come and go here; state changes found by comparison mark coins dirty. */
  async discover() {
    if (this.stopped) return;
    const coins = await this.deps.listCoins();
    if (this.stopped) return;
    const sweep = Date.now() - this.lastSweep >= this.t.sweepMs;
    if (sweep) this.lastSweep = Date.now();
    const changed = new Set(await this.deps.store.upsertCoins(coins));
    await this.deps.store.removeCoinsExcept(coins.map((coin) => coin.mint));
    const current = new Map(coins.map((coin) => [coin.mint, coin]));
    for (const coin of coins) {
      const known = this.coins.has(coin.mint);
      this.coins.set(coin.mint, coin);
      if (!known || changed.has(coin.mint) || sweep) this.dirty.add(coin.mint);
      if (!this.holdersDue.has(coin.mint)) this.holdersDue.set(coin.mint, Date.now());
      for (const pool of pools(coin)) this.watch(pool, coin.mint);
    }
    for (const mint of [...this.coins.keys()])
      if (!current.has(mint)) {
        const coin = this.coins.get(mint)!;
        this.coins.delete(mint);
        this.holdersDue.delete(mint);
        this.lastRefresh.delete(mint);
        this.dirty.delete(mint);
        this.failures.delete(mint);
        for (const pool of pools(coin)) this.unwatch(pool);
      }
  }

  private watch(pool: string, mint: string) {
    if (this.subscriptions.has(pool) || this.stopped) return;
    try {
      const id = this.deps.rpc.onAccountChange(new PublicKey(pool), () => this.dirty.add(mint), {
        commitment: 'confirmed',
      });
      this.subscriptions.set(pool, id);
    } catch {
      // Without a subscription the periodic comparison still finds this pool's changes.
    }
  }

  private unwatch(pool: string) {
    const id = this.subscriptions.get(pool);
    if (id === undefined) return;
    this.subscriptions.delete(pool);
    void this.deps.rpc.removeAccountChangeListener(id).catch(() => {});
  }

  async processDirty() {
    const now = Date.now();
    const ready = [...this.dirty].filter(
      (mint) =>
        !this.busy.has(mint) &&
        (this.lastRefresh.get(mint) ?? -Infinity) + this.t.minimumRefreshMs <= now &&
        (this.failures.get(mint)?.retryAt ?? 0) <= now
    );
    if (!ready.length) return;
    const batch = ready.slice(0, this.t.concurrency * 4);
    for (const mint of batch) this.dirty.delete(mint);
    let next = 0;
    let failed = 0;
    const worker = async () => {
      for (let i = next++; i < batch.length && !this.stopped; i = next++)
        await this.refresh(batch[i]!).catch(() => {
          failed++;
        });
    };
    await Promise.all(Array.from({ length: Math.min(this.t.concurrency, batch.length) }, worker));
    if (failed)
      this.log(`${failed} of ${batch.length} coin refreshes failed; retrying with backoff`);
  }

  private async refresh(mint: string) {
    this.busy.add(mint);
    try {
      const coin = await this.deps.loadCoin(mint);
      if (!coin || this.stopped) return;
      const previous = this.coins.get(mint);
      this.coins.set(mint, coin);
      await this.deps.store.upsertCoins([coin]);
      if (!previous) this.holdersDue.set(mint, Date.now());
      for (const pool of pools(coin)) this.watch(pool, mint);
      let more = false;
      for (const pool of pools(coin)) {
        const result = await scanPool({ rpc: this.deps.rpc, store: this.deps.store, pool, coin });
        more ||= result.more;
      }
      this.lastRefresh.set(mint, Date.now());
      if (more) this.dirty.add(mint);
      this.failures.delete(mint);
    } catch (error) {
      const count = (this.failures.get(mint)?.count ?? 0) + 1;
      this.failures.set(mint, { count, retryAt: Date.now() + Math.min(60_000, 1000 * 2 ** count) });
      this.dirty.add(mint);
      throw error;
    } finally {
      this.busy.delete(mint);
    }
  }

  async processHolders() {
    const now = Date.now();
    const due = [...this.holdersDue]
      .filter(([, at]) => at <= now)
      .sort((a, b) => a[1] - b[1])
      .slice(0, this.t.holderScansPerTick);
    for (const [mint] of due) {
      if (this.stopped) break;
      const coin = this.coins.get(mint);
      this.holdersDue.set(mint, now + this.t.holdersEveryMs);
      if (!coin) continue;
      try {
        const scan = await scanHolders(this.deps.rpc, {
          mint,
          excludedAccounts: await this.deps.holderExclusions(coin),
        });
        if (!this.stopped) await this.deps.store.replaceHolders(mint, scan);
      } catch (error) {
        // Try again soon rather than waiting for the next full period.
        this.holdersDue.set(mint, now + 60_000);
        throw error;
      }
    }
  }

  async heartbeat() {
    const began = Date.now();
    const [clock, [sample]] = await Promise.all([
      readDisplayClock(this.deps.rpc)
        .then((clock) => ({ ...clock, rpcMs: Date.now() - began }))
        .catch((): null => null),
      this.deps.rpc.getRecentPerformanceSamples(1).catch((): PerfSample[] => []),
    ]);
    if (this.stopped) return;
    await this.deps.store.heartbeat({
      slot: clock?.slot ?? null,
      chainTime: clock?.chainTime ?? null,
      rpcMs: clock?.rpcMs ?? null,
      tps:
        sample && sample.samplePeriodSecs > 0
          ? sample.numTransactions / sample.samplePeriodSecs
          : null,
    });
  }
}

const pools = (coin: Coin) => [coin.pool, ...(coin.migratedPool ? [coin.migratedPool] : [])];
