// Starts the display indexer in this process. Several web or worker processes may call this;
// a Postgres advisory lock lets exactly one of them index at a time, and another takes over
// if that one's database session ends.
import type { PoolClient } from 'pg';
import { database } from '../database';
import { connection, freshCoin, freshCoins, networkGenesis } from '../dbc';
import { holderExclusions } from '../holderDisplay';
import { DisplayIndexer } from './indexer';
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
  const genesis = await networkGenesis(true);
  const pool = database();
  for (;;) {
    const client = await pool.connect();
    let held = false;
    try {
      held = (
        await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [
          `display-indexer:${genesis}`,
        ])
      ).rows[0]!.ok;
    } catch {
      held = false;
    }
    if (!held) {
      client.release();
      await sleep(LOCK_RETRY_MS);
      continue;
    }
    console.info('[display-indexer] holding the indexer lock; starting');
    try {
      await lead(client, genesis);
      console.info('[display-indexer] lost the indexer lock; will try again');
    } catch (error) {
      console.error(
        `[display-indexer] failed: ${error instanceof Error ? error.message : 'unknown error'}; restarting`
      );
    }
    await sleep(LOCK_RETRY_MS);
  }
}

/** Runs the indexer while this session holds the lock. Returns when the session is gone. */
async function lead(client: PoolClient, genesis: string) {
  const store = new DisplayStore(database(), genesis);
  const indexer = new DisplayIndexer({
    rpc: connection,
    store,
    listCoins: freshCoins,
    loadCoin: freshCoin,
    holderExclusions,
  });
  let lost!: () => void;
  const gone = new Promise<void>((resolve) => (lost = resolve));
  client.on('error', () => lost());
  client.on('notification', (message) => {
    if (message.channel === TOUCH_CHANNEL && message.payload) indexer.touch(message.payload);
  });
  const check = setInterval(() => {
    client.query('SELECT 1').catch(() => lost());
  }, LOCK_CHECK_MS);
  check.unref?.();
  try {
    await client.query(`LISTEN ${TOUCH_CHANNEL}`);
    await indexer.start();
    await gone;
  } finally {
    clearInterval(check);
    await indexer.stop();
    client.release(true);
  }
}
