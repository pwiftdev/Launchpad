// The operator's daily XMR payout: plan a batch at one locked rate, sign it, store the signed
// transactions, relay them, wait for confirmations and settle the ledger. Every step can be
// re-run after a crash; a signed batch only ever relays the same transactions.
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { database } from '../database';
import type { MoneroWallet } from './moneroWallet';
import { openMoneroAddress } from './moneroSeal';
import { atomicForLamports, rateAtomicPerSol, type XmrPriceSource } from './xmrPrice';

/** One Monero transaction holds up to 16 outputs including change. */
export const MAX_CLAIMS_PER_BATCH = 15;
export const REQUIRED_CONFIRMATIONS = 10;
/** Kept unspent above the batch so the network fee is always covered. */
export const DEFAULT_FEE_BUFFER_ATOMIC = 20_000_000_000n; // 0.02 XMR
export const DEFAULT_FEE_BPS = 100;

type Db = Pick<Pool, 'query' | 'connect'>;
type Batch = {
  id: string;
  status: 'planned' | 'signed' | 'sent' | 'paid' | 'failed';
  total_atomic: string;
  tx_hashes: string[];
  tx_metadata: string[] | null;
  created_at: Date;
};
export type PayoutAlert = { level: 'warning' | 'critical'; message: string };

export class MaskedXmrPayouts {
  constructor(
    private readonly wallet: MoneroWallet,
    private readonly price: XmrPriceSource,
    private readonly network: string,
    private readonly options: {
      feeBps?: number;
      feeBufferAtomic?: bigint;
      alert?: (alert: PayoutAlert) => void;
      db?: Db;
    } = {}
  ) {}
  private get db() {
    return this.options.db ?? database();
  }
  private alert(level: PayoutAlert['level'], message: string) {
    (this.options.alert ?? ((a) => console.warn(`[xmr-payouts] ${a.level}: ${a.message}`)))({
      level,
      message,
    });
  }

  /** Records whether native payouts work, for the claim screen. Never throws. */
  async heartbeat() {
    try {
      const [height, balance] = await Promise.all([this.wallet.height(), this.wallet.balance()]);
      await this.status(true, balance.unlocked, height, null);
      return { ok: true, unlocked: balance.unlocked, height };
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 200) : 'unknown error';
      await this.status(false, 0n, null, detail).catch(() => {});
      this.alert('critical', `Monero wallet unreachable: ${detail}`);
      return { ok: false, detail };
    }
  }

  private status(ok: boolean, unlocked: bigint, height: number | null, detail: string | null) {
    return this.db.query(
      `INSERT INTO masked_payout_status(network_genesis,monero_ok,unlocked_atomic,wallet_height,detail,heartbeat_at)
       VALUES($1,$2,$3,$4,$5,now()) ON CONFLICT(network_genesis) DO UPDATE SET monero_ok=EXCLUDED.monero_ok,
       unlocked_atomic=EXCLUDED.unlocked_atomic,wallet_height=EXCLUDED.wallet_height,detail=EXCLUDED.detail,heartbeat_at=now()`,
      [this.network, ok, unlocked.toString(), height, detail]
    );
  }

  async openBatch(): Promise<Batch | null> {
    return (
      (
        await this.db.query<Batch>(
          `SELECT id,status,total_atomic::text,tx_hashes,tx_metadata,created_at FROM masked_xmr_batches
           WHERE network_genesis=$1 AND status IN('planned','signed','sent')`,
          [this.network]
        )
      ).rows[0] ?? null
    );
  }

  /**
   * Prices the oldest waiting XMR claims at one locked rate. If the treasury cannot cover them
   * with a fee buffer, nothing is planned and the top-up needed is reported.
   */
  async plan() {
    const open = await this.openBatch();
    if (open) return { status: 'open' as const, batch: open.id };
    const claims = (
      await this.db.query<{ id: string; lamports: string }>(
        `SELECT id,lamports::text FROM masked_claims WHERE network_genesis=$1 AND currency='xmr' AND status='queued'
         ORDER BY created_at,id LIMIT $2`,
        [this.network, MAX_CLAIMS_PER_BATCH]
      )
    ).rows;
    if (!claims.length) return { status: 'idle' as const };
    const quote = await this.price();
    const feeBps = this.options.feeBps ?? DEFAULT_FEE_BPS;
    const rate = rateAtomicPerSol(quote, feeBps);
    const priced = claims.map((claim) => ({
      ...claim,
      atomic: atomicForLamports(BigInt(claim.lamports), rate),
    }));
    const payable = priced.filter((claim) => claim.atomic > 0n);
    if (!payable.length) return { status: 'idle' as const };
    const total = payable.reduce((sum, claim) => sum + claim.atomic, 0n);
    const { unlocked } = await this.wallet.balance();
    const needed = total + (this.options.feeBufferAtomic ?? DEFAULT_FEE_BUFFER_ATOMIC);
    if (unlocked < needed) {
      this.alert(
        'warning',
        `Treasury top-up needed: ${needed - unlocked} piconero more XMR to pay ${payable.length} waiting claims`
      );
      return { status: 'top_up_needed' as const, deficitAtomic: needed - unlocked };
    }
    const id = randomUUID();
    await this.inTransaction(async (client) => {
      await client.query(
        `INSERT INTO masked_xmr_batches(id,network_genesis,rate_atomic_per_sol,fee_bps,price_source,sol_usd,xmr_usd,total_atomic)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          id,
          this.network,
          rate.toString(),
          feeBps,
          quote.source,
          quote.solUsd,
          quote.xmrUsd,
          total.toString(),
        ]
      );
      for (const claim of payable) {
        const updated = await client.query(
          `UPDATE masked_claims SET status='batched',batch_id=$2,xmr_atomic=$3 WHERE id=$1 AND status='queued' RETURNING id`,
          [claim.id, id, claim.atomic.toString()]
        );
        if (!updated.rows.length) throw new Error('A claim changed while the batch was planned');
      }
    });
    return { status: 'planned' as const, batch: id, totalAtomic: total, claims: payable.length };
  }

  /** Signs the planned batch and stores the signed transactions before anything is relayed. */
  async sign(batch: Batch) {
    if (batch.status !== 'planned') return batch;
    const claims = (
      await this.db.query<{ id: string; address_sealed: Buffer; xmr_atomic: string }>(
        `SELECT id,address_sealed,xmr_atomic::text FROM masked_claims WHERE batch_id=$1 ORDER BY created_at,id`,
        [batch.id]
      )
    ).rows;
    const destinations = claims.map((claim) => ({
      address: openMoneroAddress(claim.id, Buffer.from(claim.address_sealed)),
      amount: BigInt(claim.xmr_atomic),
    }));
    for (const destination of destinations)
      if (
        !(await this.wallet.validAddress(destination.address)) ||
        destination.amount > BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        await this.fail(batch.id, 'A payout address or amount was refused by the Monero wallet');
        return null;
      }
    const signed = await this.wallet.signTransfers(destinations);
    const sent = signed.amounts.reduce((sum, value) => sum + value, 0n);
    if (sent !== BigInt(batch.total_atomic)) {
      await this.fail(batch.id, 'The signed transactions did not match the batch total');
      return null;
    }
    const updated = (
      await this.db.query<Batch>(
        `UPDATE masked_xmr_batches SET status='signed',tx_hashes=$2,tx_metadata=$3,network_fee_atomic=$4
         WHERE id=$1 AND status='planned' RETURNING id,status,total_atomic::text,tx_hashes,tx_metadata,created_at`,
        [
          batch.id,
          signed.txHashes,
          signed.txMetadata,
          signed.fees.reduce((sum, fee) => sum + fee, 0n).toString(),
        ]
      )
    ).rows[0];
    return updated ?? (await this.openBatch());
  }

  /** Broadcasts the stored transactions. Safe to repeat: they are always the same ones. */
  async relay(batch: Batch) {
    if (batch.status !== 'signed' || !batch.tx_metadata) return batch;
    for (const metadata of batch.tx_metadata) await this.wallet.relay(metadata);
    await this.inTransaction(async (client) => {
      await client.query(
        `UPDATE masked_xmr_batches SET status='sent' WHERE id=$1 AND status='signed'`,
        [batch.id]
      );
      await client.query(
        `UPDATE masked_claims SET status='sent' WHERE batch_id=$1 AND status='batched'`,
        [batch.id]
      );
    });
    return { ...batch, status: 'sent' as const };
  }

  /** Settles once every transaction is deeply confirmed; reports anything stuck or failed. */
  async confirm(batch: Batch) {
    if (batch.status !== 'sent') return { status: batch.status };
    const states = await Promise.all(
      batch.tx_hashes.map((hash) => this.wallet.confirmations(hash))
    );
    if (states.every((state) => state?.failed)) {
      await this.fail(batch.id, 'Every Monero transaction in the batch failed');
      return { status: 'failed' as const };
    }
    if (states.some((state) => state?.failed)) {
      this.alert('critical', `XMR batch ${batch.id} partly failed; it needs manual review`);
      return { status: 'manual_review' as const };
    }
    if (states.some((state) => !state || state.confirmations < REQUIRED_CONFIRMATIONS)) {
      if (Date.now() - new Date(batch.created_at).getTime() > 6 * 3600_000)
        this.alert('warning', `XMR batch ${batch.id} is still unconfirmed after six hours`);
      return { status: 'confirming' as const };
    }
    await this.settle(batch.id);
    return { status: 'paid' as const };
  }

  /** Paid claims leave the payout ledger; their SOL becomes the coins' platform income. */
  private async settle(batchId: string) {
    await this.inTransaction(async (client) => {
      const items = (
        await client.query<{
          claim_id: string;
          mint: string;
          kind: 'creator' | 'holder';
          lamports: string;
        }>(
          `SELECT i.claim_id,i.mint,i.kind,sum(i.lamports)::text AS lamports FROM masked_claim_items i
           JOIN masked_claims c ON c.id=i.claim_id WHERE c.batch_id=$1 AND c.status='sent'
           GROUP BY i.claim_id,i.mint,i.kind ORDER BY i.mint`,
          [batchId]
        )
      ).rows;
      await lockLedger(
        client,
        this.network,
        items.map((item) => item.mint)
      );
      for (const item of items) {
        const bucket = item.kind === 'creator' ? 'creator' : 'community';
        const moved = await client.query(
          `UPDATE wallet_balances SET reserved=reserved-$4,spent=spent+$4
           WHERE network_genesis=$1 AND mint=$2 AND bucket=$3 AND reserved>=$4 RETURNING mint`,
          [this.network, item.mint, bucket, item.lamports]
        );
        if (!moved.rows.length) throw new Error('A paid claim is missing its reservation');
        await client.query(
          `INSERT INTO wallet_balances(network_genesis,mint,bucket,funded) VALUES($1,$2,'platform',$3)
           ON CONFLICT(network_genesis,mint,bucket) DO UPDATE SET funded=wallet_balances.funded+EXCLUDED.funded`,
          [this.network, item.mint, item.lamports]
        );
        await client.query(
          `INSERT INTO masked_xmr_settlements(batch_id,claim_id,network_genesis,mint,bucket,lamports) VALUES($1,$2,$3,$4,$5,$6)`,
          [batchId, item.claim_id, this.network, item.mint, bucket, item.lamports]
        );
      }
      await client.query(
        `UPDATE masked_claims SET status='paid',address_sealed=NULL WHERE batch_id=$1 AND status='sent'`,
        [batchId]
      );
      await client.query(
        `UPDATE masked_xmr_batches SET status='paid',tx_metadata=NULL WHERE id=$1 AND status='sent'`,
        [batchId]
      );
    });
  }

  /** A batch that never paid returns every claim's earnings so the wallet can claim again. */
  async fail(batchId: string, reason: string) {
    this.alert('critical', `XMR batch ${batchId} failed: ${reason}`);
    await this.inTransaction(async (client) => {
      const claims = (
        await client.query<{ id: string }>(
          `SELECT id FROM masked_claims WHERE batch_id=$1 AND status IN('batched','sent')`,
          [batchId]
        )
      ).rows;
      for (const claim of claims) await releaseClaim(client, this.network, claim.id, reason);
      await client.query(
        `UPDATE masked_xmr_batches SET status='failed',failure=$2,tx_metadata=NULL WHERE id=$1 AND status IN('planned','signed','sent')`,
        [batchId, reason]
      );
    });
  }

  /** True once per UTC day from the configured hour, until that day's batch is planned. */
  async due(now = new Date(), hourUtc = 12) {
    if (now.getUTCHours() < hourUtc) return false;
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const planned = await this.db.query(
      'SELECT 1 FROM masked_xmr_batches WHERE network_genesis=$1 AND created_at>=$2 LIMIT 1',
      [this.network, day]
    );
    return planned.rows.length === 0;
  }

  /** One pass: heartbeat, then move the open batch forward or plan a new one when due. */
  async runOnce(due: boolean) {
    const health = await this.heartbeat();
    if (!health.ok) return { status: 'wallet_unavailable' as const };
    let batch = await this.openBatch();
    if (!batch && due) {
      const planned = await this.plan();
      if (planned.status !== 'planned') return planned;
      batch = await this.openBatch();
    }
    if (!batch) return { status: 'idle' as const };
    if (batch.status === 'planned') batch = await this.sign(batch);
    if (batch?.status === 'signed') batch = await this.relay(batch);
    if (batch?.status === 'sent') return this.confirm(batch);
    return { status: batch?.status ?? 'failed' };
  }

  private async inTransaction<T>(work: (client: PoolClient) => Promise<T>) {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}

/** The payout ledger's lock order: the network's operating lock, then each coin sorted. */
async function lockLedger(client: Pick<PoolClient, 'query'>, network: string, mints: string[]) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `wallet-operating:${network}`,
  ]);
  for (const mint of [...new Set(mints)].sort())
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `wallet-settlement:${network}:${mint}`,
    ]);
}

/** Returns an unpaid claim's earnings: creator reservations are released, holder hours freed. */
export async function releaseClaim(
  client: Pick<PoolClient, 'query'>,
  network: string,
  claimId: string,
  reason: string
) {
  const creators = (
    await client.query<{ mint: string; lamports: string }>(
      `SELECT mint,sum(lamports)::text AS lamports FROM masked_claim_items WHERE claim_id=$1 AND kind='creator' GROUP BY mint`,
      [claimId]
    )
  ).rows;
  await lockLedger(
    client,
    network,
    creators.map((row) => row.mint)
  );
  for (const row of creators)
    await client.query(
      `UPDATE wallet_balances SET reserved=reserved-$3 WHERE network_genesis=$1 AND mint=$2 AND bucket='creator'`,
      [network, row.mint, row.lamports]
    );
  await client.query('DELETE FROM masked_claim_items WHERE claim_id=$1', [claimId]);
  await client.query(
    `UPDATE masked_claims SET status='failed',failure=$2,address_sealed=NULL WHERE id=$1 AND status IN('queued','batched','sent')`,
    [claimId, reason.slice(0, 300)]
  );
}
