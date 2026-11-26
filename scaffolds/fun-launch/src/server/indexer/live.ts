// One Postgres LISTEN connection per web process fans index updates out to every open browser
// stream. Viewers cost no RPC calls; the cap below only bounds memory and open sockets.
import { Client } from 'pg';
import { databaseConfig } from '../../../../../scripts/postgres-config.cjs';
import { DISPLAY_CHANNEL, decodeEvent, type DisplayEvent } from './store';

export const MAX_LIVE_CLIENTS = 5000;
type Listener = (event: DisplayEvent) => void;

export class LiveHub {
  private listeners = new Map<string, Set<Listener>>();
  private count = 0;
  private client?: { end: () => Promise<void> };
  private connecting?: Promise<void>;
  private retryMs = 1000;

  constructor(
    private connect: (
      onEvent: (payload: string) => void,
      onLost: () => void
    ) => Promise<{
      end: () => Promise<void>;
    }>,
    private capacity = MAX_LIVE_CLIENTS
  ) {}

  get size() {
    return this.count;
  }

  /** `topic` is a mint, or `board` for every board change. Throws when the hub is full. */
  async subscribe(topic: string, listener: Listener): Promise<() => void> {
    if (this.count >= this.capacity) throw new Error('Live update capacity reached');
    await this.ensure();
    let set = this.listeners.get(topic);
    if (!set) this.listeners.set(topic, (set = new Set()));
    set.add(listener);
    this.count++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      set.delete(listener);
      this.count--;
      if (!set.size) this.listeners.delete(topic);
    };
  }

  /** Delivers one notification payload; exported for tests and the reconnect path. */
  dispatch(payload: string) {
    const event = decodeEvent(payload);
    if (!event) return;
    const topics = event.kind === 'board' ? ['board'] : [event.mint, 'board'];
    for (const topic of topics)
      for (const listener of this.listeners.get(topic) ?? []) {
        try {
          listener(event);
        } catch {
          /* A closed stream must not stop the others. */
        }
      }
  }

  private ensure() {
    if (this.client) return Promise.resolve();
    this.connecting ??= this.connect(
      (payload) => this.dispatch(payload),
      () => this.lost()
    )
      .then((client) => {
        this.client = client;
        this.retryMs = 1000;
      })
      .finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }

  private lost() {
    const old = this.client;
    this.client = undefined;
    void old?.end().catch(() => {});
    // Tell open streams to refresh once, then reconnect in the background.
    this.dispatch('board');
    const wait = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 30_000);
    setTimeout(() => void this.ensure().catch(() => this.lost()), wait).unref?.();
  }
}

async function listen(onEvent: (payload: string) => void, onLost: () => void) {
  const client = new Client(databaseConfig());
  client.on('error', onLost);
  client.on('end', onLost);
  client.on('notification', (message) => {
    if (message.channel === DISPLAY_CHANNEL && message.payload) onEvent(message.payload);
  });
  await client.connect();
  await client.query(`LISTEN ${DISPLAY_CHANNEL}`);
  return {
    end: async () => {
      client.removeAllListeners();
      await client.end();
    },
  };
}

let hub: LiveHub | undefined;
export const liveHub = () => (hub ??= new LiveHub(listen));
