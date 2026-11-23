import { PublicKey, type Connection } from '@solana/web3.js';
export type LiveCoinEvent = { signature: string; slot: number };
type Watch = {
  pools: Set<string>;
  listeners: Set<(event: LiveCoinEvent) => void>;
  ids: number[];
  timer?: ReturnType<typeof setTimeout>;
  latest?: LiveCoinEvent;
};
/** Display invalidation only: logs never establish a trade, balance, reward or finalized receipt. */
export class CoinLiveHub {
  private watches = new Map<string, Watch>();
  private listeners = 0;
  constructor(
    private rpc: Pick<Connection, 'onLogs' | 'removeOnLogsListener'>,
    private invalidate: (mint: string, pools: string[]) => void,
    private maximumClients = 128,
    private maximumCoins = 32
  ) {}
  subscribe(mint: string, pools: string[], listener: (event: LiveCoinEvent) => void): () => void {
    let watch = this.watches.get(mint);
    if (this.listeners >= this.maximumClients || (!watch && this.watches.size >= this.maximumCoins))
      throw new Error('Live display capacity reached');
    if (!watch) {
      watch = { pools: new Set(), listeners: new Set(), ids: [] };
      this.watches.set(mint, watch);
    }
    const active = watch;
    try {
      for (const pool of pools) {
        if (active.pools.has(pool)) continue;
        if (active.pools.size >= 2) throw new Error('Too many canonical pools');
        const key = new PublicKey(pool);
        active.pools.add(pool);
        active.ids.push(
          this.rpc.onLogs(
            key,
            (logs, context) => {
              if (logs.err || !Number.isSafeInteger(context.slot) || context.slot < 0) return;
              active.latest = { signature: logs.signature, slot: context.slot };
              if (active.timer) return;
              active.timer = setTimeout(() => {
                delete active.timer;
                const event = active.latest;
                if (!event) return;
                this.invalidate(mint, [...active.pools]);
                for (const sink of active.listeners) {
                  try {
                    sink(event);
                  } catch {
                    /* A closed client must not stop another client. */
                  }
                }
              }, 1000);
              active.timer.unref?.();
            },
            'confirmed'
          )
        );
      }
    } catch (error) {
      if (!active.listeners.size) this.remove(mint, active);
      throw error;
    }
    active.listeners.add(listener);
    this.listeners++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active.listeners.delete(listener);
      this.listeners--;
      if (!active.listeners.size) this.remove(mint, active);
    };
  }
  private remove(mint: string, watch: Watch) {
    if (watch.timer) clearTimeout(watch.timer);
    this.watches.delete(mint);
    for (const id of watch.ids) void this.rpc.removeOnLogsListener(id).catch(() => {});
  }
}
