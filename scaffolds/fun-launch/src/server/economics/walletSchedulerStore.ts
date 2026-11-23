import type { Pool } from 'pg';
import { database } from '../database';
import type { SchedulerLease } from './scheduler';

/** Dedicated session lock is released by PostgreSQL after process/connection death. No network work in a SQL transaction. */
export class WalletSchedulerStore {
  constructor(
    private readonly genesis: string,
    private readonly collector: string,
    private readonly supplied?: Pick<Pool, 'query' | 'connect'>
  ) {}
  private get db() {
    return this.supplied ?? database();
  }
  async acquire(): Promise<SchedulerLease | null> {
    const client = await this.db.connect(),
      lock = `rinsed-wallet-worker:${this.genesis}:${this.collector}`;
    const controller = new AbortController();
    let alive = true,
      released = false;
    const lost = () => {
      alive = false;
      controller.abort();
    };
    client.on('error', lost);
    client.on('end', lost);
    try {
      const locked = (
        await client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',
          [lock]
        )
      ).rows[0]?.locked;
      if (!locked) {
        client.removeListener('error', lost);
        client.removeListener('end', lost);
        client.release();
        return null;
      }
      await client.query(
        `INSERT INTO wallet_scheduler_state(network_genesis,collector,last_status,last_started_at,last_progress_at)
        VALUES($1,$2,'running',clock_timestamp(),clock_timestamp()) ON CONFLICT(network_genesis,collector) DO UPDATE SET
        last_status='running',last_started_at=clock_timestamp(),last_progress_at=clock_timestamp(),last_processed=0,last_failed=0`,
        [this.genesis, this.collector]
      );
      const update = async (sql: string, args: unknown[]) => {
        if (!alive) throw new Error('Scheduler lock connection lost');
        await client.query(sql, args);
      };
      return {
        alive: () => alive,
        signal: controller.signal,
        progress: (mint, processed, failed) =>
          update(
            `UPDATE wallet_scheduler_state SET cursor_mint=$3,last_progress_at=clock_timestamp(),last_processed=$4,last_failed=$5
          WHERE network_genesis=$1 AND collector=$2`,
            [this.genesis, this.collector, mint, processed, failed]
          ),
        finish: (status, processed, failed) =>
          update(
            `UPDATE wallet_scheduler_state SET last_status=$3,last_completed_at=clock_timestamp(),last_progress_at=clock_timestamp(),last_processed=$4,last_failed=$5
          WHERE network_genesis=$1 AND collector=$2`,
            [this.genesis, this.collector, status, processed, failed]
          ),
        release: async () => {
          if (released) return;
          released = true;
          try {
            if (alive)
              await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lock]);
          } catch {
            alive = false;
          } finally {
            client.removeListener('error', lost);
            client.removeListener('end', lost);
            client.release(!alive);
            alive = false;
          }
        },
      };
    } catch (error) {
      client.removeListener('error', lost);
      client.removeListener('end', lost);
      client.release(true);
      throw error;
    }
  }
  async discover(limit: number): Promise<string[]> {
    const rows = (
      await this.db.query<{ mint: string }>(
        `SELECT coin.mint FROM launch_coins coin JOIN launch_configs cfg
      ON(cfg.network_genesis=coin.network_genesis AND cfg.config_key=coin.config_key)
      LEFT JOIN wallet_scheduler_state scheduler ON(scheduler.network_genesis=coin.network_genesis AND scheduler.collector=$2)
      WHERE coin.network_genesis=$1 AND coin.policy_version IN('wallet-v1','bond-v1','dev-v1','cashback-v1','mskd-v1') AND cfg.policy_version=coin.policy_version AND cfg.expected_fee_claimer=$2
      ORDER BY CASE WHEN scheduler.cursor_mint IS NULL OR coin.mint>scheduler.cursor_mint THEN 0 ELSE 1 END,coin.mint LIMIT $3`,
        [this.genesis, this.collector, limit]
      )
    ).rows;
    return rows.map((row) => row.mint);
  }
}
