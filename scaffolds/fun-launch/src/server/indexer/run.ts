// Starts the display indexer in this process. Several web or worker processes may call this;
// a Postgres advisory lock lets exactly one of them index at a time, and another takes over
// if that one's database session ends.
import type { PoolClient } from 'pg';
import { database } from '../database';
import { connection, freshCoin, freshCoins, networkGenesis } from '../dbc';
import { holderExclusions } from '../holderDisplay';
import { DisplayIndexer } from './indexer';
import { leaseDatabase } from './leaseDatabase';
import { DisplayStore, TOUCH_CHANNEL } from './store';
const LOCK_RETRY_MS = 30_000;
const LOCK_CHECK_MS = 15_000;

let running: Promise<void> | undefined;
export function startDisplayIndexer() {
  running ??= run().catch((error: unknown) => {
    console.error(
      `[display-indexer] stopped: ${error instanceof Error ? error.message : 'unknown error'}`
    );
    running = undefined;
  });
  return running;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

async function run() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  for (;;) {
    try {
      const genesis = await networkGenesis(true);
      const client = await database().connect();
      const onAcquireError = () => {};
      client.on('error', onAcquireError);
      const held = await client
        .query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [
          `display-indexer:${genesis}`,
        ])
        .then((result) => result.rows[0]?.ok === true)
        .catch((error: unknown) => {
          client.release(true);
          throw error;
        });
      client.off('error', onAcquireError);
      if (held) {
        console.info('[display-indexer] holding the indexer lock; starting');
        await lead(client, genesis);
        console.info('[display-indexer] lost the indexer lock; will try again');
      } else client.release();
    } catch {
      console.error('[display-indexer] failed to start or lost its connection; retrying');
    }
    await sleep(LOCK_RETRY_MS);
  }
}

/** Runs the indexer while this session holds the lock. Returns when the session is gone. */
async function lead(client: PoolClient, genesis: string) {
  const lease = leaseDatabase(client);
  const store = new DisplayStore(lease.db, genesis);
  const indexer = new DisplayIndexer({
    rpc: connection,
    store,
    listCoins: freshCoins,
    loadCoin: freshCoin,
    holderExclusions,
  });
  let finish!: () => void;
  const gone = new Promise<void>((resolve) => (finish = resolve));
  const lost = () => {
    lease.close();
    finish();
  };
  client.on('error', lost);
  client.on('end', lost);
  client.on('notification', (message) => {
    if (message.channel === TOUCH_CHANNEL && message.payload) indexer.touch(message.payload);
  });
  let checking = false;
  const check = setInterval(() => {
    if (checking) {
      lost();
      return;
    }
    checking = true;
    void lease.db.query('SELECT 1').then(() => {
      checking = false;
    }, lost);
  }, LOCK_CHECK_MS);
  check.unref?.();
  try {
    await Promise.race([
      lease.db.query(`LISTEN ${TOUCH_CHANNEL}`).then(() => indexer.start()),
      gone,
    ]);
    await gone;
  } finally {
    clearInterval(check);
    lease.close();
    client.release(true);
    void indexer.stop();
  }
}
