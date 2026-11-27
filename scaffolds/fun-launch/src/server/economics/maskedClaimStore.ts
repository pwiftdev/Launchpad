// Masked claims: one request takes everything a wallet has earned across Masked coins.
// SOL claims become ordinary per-coin payout jobs the operator executes; XMR claims wait for the
// daily batch, and wXMR claims are paid by swap-and-send wallet jobs. Every amount is reserved under the same locks the payout ledger uses.
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { database } from '../database';
import { MINIMUM_HOLDER_PAYOUT_LAMPORTS, SOL_REWARD_MINT } from '@/lib/rewards';
import type {
  ClaimCurrency,
  CoinEarnings,
  EarningsView,
  MaskedClaimView,
} from '@/lib/maskedEarnings';
import { attachHolderAllocations, MASKED_UNCLAIMED } from './walletHolderClaims';
import { sealMoneroAddress } from './moneroSeal';

/** Until a minimum is decided, an XMR claim needs at least 0.05 SOL of earnings. */
export const DEFAULT_MINIMUM_XMR_LAMPORTS = 50_000_000n;
export function minimumXmrLamports(env = process.env) {
  const value = env.MASKED_MINIMUM_XMR_CLAIM_LAMPORTS;
  return value && /^[1-9]\d{0,17}$/.test(value) ? BigInt(value) : DEFAULT_MINIMUM_XMR_LAMPORTS;
}
/**
 * wXMR stands in for XMR while native payouts are down. Switch it on only once the operator has
 * the wXMR market configured (MSKD_PAYOUT_POOL and the payout mint), since that is what pays it.
 */
export const wxmrPayoutsEnabled = (env = process.env) => env.MASKED_WXMR_PAYOUTS_ENABLED === 'true';
/** The operator's Monero heartbeat counts as current for this long. */
const PAYOUT_STATUS_FRESH_SECONDS = 15 * 60;

type CreatorRow = { mint: string; available: string; collector: string; treasury: string };
type HolderRow = {
  mint: string;
  epoch: string;
  lamports: string;
  collector: string;
  treasury: string;
};

const UNCLAIMED_HOLDER = `FROM wallet_allocations a
 JOIN launch_coins c USING(network_genesis,mint)
 JOIN launch_configs cfg ON(cfg.network_genesis=c.network_genesis AND cfg.config_key=c.config_key)
 WHERE a.network_genesis=$1 AND a.wallet=$2 AND c.mode='masked'
 AND NOT EXISTS (
   SELECT 1 FROM wallet_claim_allocations ca JOIN wallet_jobs j ON j.id=ca.job_id
   WHERE (ca.network_genesis,ca.mint,ca.wallet,ca.epoch)=(a.network_genesis,a.mint,a.wallet,a.epoch)
   AND j.status<>'failed'
 ) ${MASKED_UNCLAIMED}`;

export class MaskedClaimError extends Error {
  constructor(
    message: string,
    readonly status = 409
  ) {
    super(message);
  }
}

export class MaskedClaimStore {
  constructor(private readonly supplied?: Pick<Pool, 'query' | 'connect'>) {}
  private get db() {
    return this.supplied ?? database();
  }

  private async creatorRows(
    db: Pick<PoolClient, 'query'>,
    network: string,
    wallet: string,
    lock = false
  ) {
    return (
      await db.query<CreatorRow>(
        `SELECT c.mint,(b.funded-b.reserved-b.spent)::text AS available,cfg.expected_fee_claimer AS collector,
           cfg.expected_leftover_receiver AS treasury
         FROM launch_coins c
         JOIN launch_configs cfg ON(cfg.network_genesis=c.network_genesis AND cfg.config_key=c.config_key)
         JOIN wallet_balances b ON(b.network_genesis=c.network_genesis AND b.mint=c.mint AND b.bucket='creator')
         WHERE c.network_genesis=$1 AND c.mode='masked' AND c.original_deployer=$2 AND b.funded>b.reserved+b.spent
         ORDER BY c.mint ${lock ? 'FOR UPDATE OF b' : ''}`,
        [network, wallet]
      )
    ).rows;
  }

  private async holderRows(db: Pick<PoolClient, 'query'>, network: string, wallet: string) {
    return (
      await db.query<HolderRow>(
        `SELECT a.mint,a.epoch::text,a.lamports::text,cfg.expected_fee_claimer AS collector,
           cfg.expected_leftover_receiver AS treasury ${UNCLAIMED_HOLDER} ORDER BY a.mint,a.epoch`,
        [network, wallet]
      )
    ).rows;
  }

  /** What a wallet can claim now, and how much of it SOL can pay right away. */
  private summarize(creators: CreatorRow[], holders: HolderRow[]) {
    const coins = new Map<
      string,
      { creator: bigint; holder: bigint; hours: number; lastEpoch: number }
    >();
    const entry = (mint: string) => {
      let value = coins.get(mint);
      if (!value) coins.set(mint, (value = { creator: 0n, holder: 0n, hours: 0, lastEpoch: -1 }));
      return value;
    };
    for (const row of creators) entry(row.mint).creator += BigInt(row.available);
    for (const row of holders) {
      const value = entry(row.mint);
      value.holder += BigInt(row.lamports);
      value.hours++;
      value.lastEpoch = Math.max(value.lastEpoch, Number(row.epoch));
    }
    let total = 0n,
      sol = 0n;
    for (const value of coins.values()) {
      total += value.creator + value.holder;
      if (value.creator >= MINIMUM_HOLDER_PAYOUT_LAMPORTS) sol += value.creator;
      if (value.holder >= MINIMUM_HOLDER_PAYOUT_LAMPORTS) sol += value.holder;
    }
    return { coins, total, sol };
  }

  async xmrAvailable(network: string) {
    const row = (
      await this.db.query<{ monero_ok: boolean; age: number }>(
        `SELECT monero_ok,extract(epoch FROM now()-heartbeat_at) AS age FROM masked_payout_status WHERE network_genesis=$1`,
        [network]
      )
    ).rows[0];
    return !!row && row.monero_ok && Number(row.age) <= PAYOUT_STATUS_FRESH_SECONDS;
  }

  async earnings(network: string, wallet: string): Promise<EarningsView> {
    const [creators, holders, claims, xmrAvailable] = await Promise.all([
      this.creatorRows(this.db, network, wallet),
      this.holderRows(this.db, network, wallet),
      this.claims(network, wallet),
      this.xmrAvailable(network),
    ]);
    const { coins, total, sol } = this.summarize(creators, holders);
    const list: CoinEarnings[] = [...coins].map(([mint, value]) => ({
      mint,
      creatorLamports: value.creator.toString(),
      holderLamports: value.holder.toString(),
      holderHours: value.hours,
    }));
    const open =
      claims.find((claim) => ['queued', 'batched', 'sent'].includes(claim.status)) ?? null;
    return {
      networkGenesis: network,
      wallet,
      coins: list,
      totalLamports: total.toString(),
      solClaimableLamports: sol.toString(),
      minimumXmrLamports: minimumXmrLamports().toString(),
      xmrAvailable,
      wxmrAvailable: !xmrAvailable && wxmrPayoutsEnabled(),
      openClaim: open,
      history: claims,
    };
  }

  async claims(network: string, wallet: string, limit = 20): Promise<MaskedClaimView[]> {
    const rows = (
      await this.db.query<{
        id: string;
        currency: ClaimCurrency;
        lamports: string;
        status: MaskedClaimView['status'];
        xmr_atomic: string | null;
        created_at: Date;
        failure: string | null;
        job_statuses: string[] | null;
      }>(
        `SELECT m.id,m.currency,m.lamports::text,m.status,m.xmr_atomic::text,m.created_at,m.failure,
           (SELECT array_agg(j.status) FROM wallet_jobs j WHERE j.id=ANY(m.sol_jobs)) AS job_statuses
         FROM masked_claims m WHERE m.network_genesis=$1 AND m.wallet=$2 ORDER BY m.created_at DESC LIMIT $3`,
        [network, wallet, limit]
      )
    ).rows;
    return rows.map((row) => ({
      id: row.id,
      currency: row.currency,
      lamports: row.lamports,
      // SOL claims follow their payout jobs.
      status:
        row.currency === 'sol' && row.status === 'sent' && row.job_statuses?.length
          ? row.job_statuses.every((status) => status === 'finalized')
            ? 'paid'
            : row.job_statuses.every((status) => status === 'finalized' || status === 'failed')
              ? 'failed'
              : 'sent'
          : row.status,
      xmrAtomic: row.xmr_atomic,
      createdAt: new Date(row.created_at).toISOString(),
      failure: row.failure,
    }));
  }

  /**
   * Takes everything the wallet has earned for one payout. The signed amount must match what is
   * claimable now exactly; new income since the screen loaded means the wallet signs again.
   */
  async requestClaim(input: {
    networkGenesis: string;
    wallet: string;
    currency: ClaimCurrency;
    lamports: bigint;
    requestId: string;
    authorizationDigest: string;
    moneroAddress?: string;
    xmrAvailable: boolean;
    env?: NodeJS.ProcessEnv;
  }): Promise<MaskedClaimView> {
    const { networkGenesis: network, wallet, currency } = input;
    // XMR claims queue even while the payout wallet is down and pay when it returns.
    if (currency === 'xmr' && !input.moneroAddress)
      throw new MaskedClaimError('Native XMR payouts need a Monero address');
    if (currency === 'wxmr' && (input.xmrAvailable || !wxmrPayoutsEnabled(input.env)))
      throw new MaskedClaimError('wXMR is offered only while native XMR payouts are down');
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      // The payout ledger's lock order: the network's operating lock, then each coin in turn.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `wallet-operating:${network}`,
      ]);
      const existing = (
        await client.query<{ id: string; authorization_digest: string }>(
          'SELECT id,authorization_digest FROM masked_claims WHERE network_genesis=$1 AND request_id=$2',
          [network, input.requestId]
        )
      ).rows[0];
      if (existing) {
        if (existing.authorization_digest !== input.authorizationDigest)
          throw new MaskedClaimError('This request conflicts with an earlier signed claim');
        await client.query('COMMIT');
        return (await this.claims(network, wallet, 50)).find((claim) => claim.id === existing.id)!;
      }
      const preliminary = [
        ...(await this.creatorRows(client, network, wallet)).map((row) => row.mint),
        ...(await this.holderRows(client, network, wallet)).map((row) => row.mint),
      ];
      for (const mint of [...new Set(preliminary)].sort())
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `wallet-settlement:${network}:${mint}`,
        ]);
      const creators = await this.creatorRows(client, network, wallet, true);
      const holders = await this.holderRows(client, network, wallet);
      const { coins, total, sol } = this.summarize(creators, holders);
      const amount = currency === 'sol' ? sol : total;
      if (amount <= 0n) throw new MaskedClaimError('Nothing is claimable yet');
      if (amount !== input.lamports)
        throw new MaskedClaimError('Your earnings changed. Refresh and sign again.');
      if (currency !== 'sol' && amount < minimumXmrLamports(input.env))
        throw new MaskedClaimError('Earn a little more before claiming in XMR', 400);
      const id = randomUUID();
      const jobs: string[] = [];
      if (currency === 'sol') {
        for (const row of creators) {
          const value = BigInt(row.available);
          if (value < MINIMUM_HOLDER_PAYOUT_LAMPORTS) continue;
          await client.query(
            "UPDATE wallet_balances SET reserved=reserved+$3 WHERE network_genesis=$1 AND mint=$2 AND bucket='creator'",
            [network, row.mint, value.toString()]
          );
          jobs.push(
            await insertJob(client, {
              network,
              row,
              kind: 'creator_claim',
              wallet,
              epoch: null,
              lamports: value,
              id,
            })
          );
        }
        for (const [mint, value] of coins) {
          if (value.holder < MINIMUM_HOLDER_PAYOUT_LAMPORTS) continue;
          const row = holders.find((holder) => holder.mint === mint)!;
          const job = await insertJob(client, {
            network,
            row,
            kind: 'community_claim',
            wallet,
            epoch: value.lastEpoch,
            lamports: value.holder,
            id,
          });
          await attachHolderAllocations(
            client,
            { networkGenesis: network, mint, wallet },
            SOL_REWARD_MINT,
            value.lastEpoch,
            job,
            value.holder,
            MINIMUM_HOLDER_PAYOUT_LAMPORTS,
            true
          );
          jobs.push(job);
        }
      }
      await client.query(
        `INSERT INTO masked_claims(id,network_genesis,wallet,currency,lamports,request_id,authorization_digest,status,address_sealed,sol_jobs)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id,
          network,
          wallet,
          currency,
          amount.toString(),
          input.requestId,
          input.authorizationDigest,
          currency === 'sol' ? 'sent' : 'queued',
          currency === 'xmr' ? sealMoneroAddress(id, input.moneroAddress!, input.env) : null,
          jobs,
        ]
      );
      if (currency !== 'sol') {
        for (const row of creators) {
          await client.query(
            "UPDATE wallet_balances SET reserved=reserved+$3 WHERE network_genesis=$1 AND mint=$2 AND bucket='creator'",
            [network, row.mint, row.available]
          );
          await client.query(
            `INSERT INTO masked_claim_items(claim_id,network_genesis,mint,kind,epoch,wallet,lamports) VALUES($1,$2,$3,'creator',NULL,$4,$5)`,
            [id, network, row.mint, wallet, row.available]
          );
        }
        if (holders.length)
          await client.query(
            `INSERT INTO masked_claim_items(claim_id,network_genesis,mint,kind,epoch,wallet,lamports)
             SELECT $1,$2,h.mint,'holder',h.epoch::bigint,$3,h.lamports::numeric FROM jsonb_to_recordset($4::jsonb) AS h(mint text,epoch text,lamports text)`,
            [
              id,
              network,
              wallet,
              JSON.stringify(
                holders.map(({ mint, epoch, lamports }) => ({ mint, epoch, lamports }))
              ),
            ]
          );
      }
      await client.query('COMMIT');
      return (await this.claims(network, wallet, 50)).find((claim) => claim.id === id)!;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error instanceof Error && /masked_claims_one_open/.test(error.message))
        throw new MaskedClaimError('Your previous claim is still being paid');
      throw error;
    } finally {
      client.release();
    }
  }
}

async function insertJob(
  client: Pick<PoolClient, 'query'>,
  args: {
    network: string;
    row: { mint: string; collector: string; treasury: string };
    kind: 'creator_claim' | 'community_claim';
    wallet: string;
    epoch: number | null;
    lamports: bigint;
    id: string;
  }
) {
  const job = randomUUID();
  await client.query(
    `INSERT INTO wallet_jobs(id,network_genesis,mint,kind,intent_key,bucket,recipient,epoch,lamports,details)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      job,
      args.network,
      args.row.mint,
      args.kind,
      `masked-claim:${args.id}:${args.kind}`,
      args.kind === 'creator_claim' ? 'creator' : 'community',
      args.wallet,
      args.epoch,
      args.lamports.toString(),
      JSON.stringify({
        collector: args.row.collector,
        treasury: args.row.treasury,
        maskedClaim: args.id,
      }),
    ]
  );
  return job;
}
