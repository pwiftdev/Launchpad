import type { Pool } from 'pg';
import { database } from '../database';
import type { SchedulerLease, SchedulerReceipt } from './scheduler';

/** Dedicated session lock is released by PostgreSQL after process/connection death. No network work in a SQL transaction. */
export class FinancialSchedulerStore {
  constructor(
    private readonly genesis: string,
    private readonly program: string,
    private readonly supplied?: Pick<Pool, 'query' | 'connect'>
  ) {}
  private get db() {
    return this.supplied ?? database();
  }
  async acquire(): Promise<SchedulerLease | null> {
    const client = await this.db.connect(),
      lock = `rinsed-unsigned-scheduler:${this.genesis}:${this.program}`;
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
        `INSERT INTO financial_scheduler_state(network_genesis,program_id,last_status,last_started_at,last_progress_at)
        VALUES($1,$2,'running',clock_timestamp(),clock_timestamp()) ON CONFLICT(network_genesis,program_id) DO UPDATE SET
        last_status='running',last_started_at=clock_timestamp(),last_progress_at=clock_timestamp(),last_processed=0,last_failed=0`,
        [this.genesis, this.program]
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
            `UPDATE financial_scheduler_state SET cursor_mint=$3,last_progress_at=clock_timestamp(),last_processed=$4,last_failed=$5
          WHERE network_genesis=$1 AND program_id=$2`,
            [this.genesis, this.program, mint, processed, failed]
          ),
        finish: (status, processed, failed) =>
          update(
            `UPDATE financial_scheduler_state SET last_status=$3,last_completed_at=clock_timestamp(),last_progress_at=clock_timestamp(),last_processed=$4,last_failed=$5
          WHERE network_genesis=$1 AND program_id=$2`,
            [this.genesis, this.program, status, processed, failed]
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
      LEFT JOIN financial_scheduler_state scheduler ON(scheduler.network_genesis=coin.network_genesis AND scheduler.program_id=$2)
      WHERE coin.network_genesis=$1 AND coin.policy_version='rinse-v1' AND cfg.policy_version='rinse-v1'
      ORDER BY CASE WHEN scheduler.cursor_mint IS NULL OR coin.mint>scheduler.cursor_mint THEN 0 ELSE 1 END,coin.mint LIMIT $3`,
        [this.genesis, this.program, limit]
      )
    ).rows;
    return rows.map((row) => row.mint);
  }
  async pending(
    mint: string,
    limit: number
  ): Promise<{ receipts: SchedulerReceipt[]; more: boolean }> {
    const rows = (
      await this.db.query<SchedulerReceipt>(
        `SELECT id,kind FROM(
      SELECT id,'operator'::text AS kind,created_at FROM financial_operator_plans WHERE network_genesis=$1 AND mint=$2
        AND signature IS NOT NULL AND status IN('signed','submitted','manual_review')
      UNION ALL SELECT id,'job'::text AS kind,created_at FROM financial_jobs WHERE network_genesis=$1 AND mint=$2
        AND signature IS NOT NULL AND status IN('signed','submitted','manual_review')) saved ORDER BY created_at,id LIMIT $3`,
        [this.genesis, mint, limit + 1]
      )
    ).rows;
    return { receipts: rows.slice(0, limit), more: rows.length > limit };
  }
}
