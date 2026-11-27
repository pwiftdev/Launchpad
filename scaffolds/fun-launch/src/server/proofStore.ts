// Reads the proof page's data from the payout ledger. Totals per UTC day only: SOL payouts are
// counted, never listed, so the page proves the money moved without pointing at who earned it.
import type { Pool } from 'pg';
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { CP_AMM_PROGRAM_ID } from '@meteora-ag/cp-amm-sdk';
import { database } from './database';
import { viewKeyMatchesAddress, type MoneroNetwork } from '@/lib/monero';
import type { ProofControl, ProofDay, ProofReceipt, ProofView } from '@/lib/proof';

type Db = Pick<Pool, 'query'>;
export const PROOF_DAYS = 30;
const RECEIPTS = 20;

const day = (column: string) => `((${column}) AT TIME ZONE 'UTC')::date::text`;

function emptyDay(date: string): ProofDay {
  return {
    day: date,
    feesCollectedLamports: '0',
    collections: 0,
    mskdBoughtLamports: '0',
    mskdBurnedTokens: '0',
    burns: 0,
    solPaidLamports: '0',
    wxmrPaidLamports: '0',
    wxmrPaidAtomic: '0',
    xmrPaidLamports: '0',
    xmrPaidAtomic: '0',
    xmrReceivedAtomic: '0',
    xmrTransactions: [],
    peoplePaid: 0,
  };
}

export class ProofStore {
  constructor(private readonly supplied?: Db) {}
  private get db() {
    return this.supplied ?? database();
  }

  async days(network: string, mskdMint: string | null, since: Date): Promise<ProofDay[]> {
    const args = [network, since];
    const [collect, burns, sol, wxmr, xmr, xmrTx, inflows, people] = await Promise.all([
      this.db.query<{ day: string; n: number; lamports: string }>(
        `SELECT ${day('s.created_at')} AS day,count(*)::int AS n,sum(s.received_lamports)::text AS lamports
         FROM wallet_settlements s JOIN launch_coins c ON(c.network_genesis=s.network_genesis AND c.mint=s.mint)
         WHERE s.network_genesis=$1 AND s.created_at>=$2 AND s.kind='collect' AND c.policy_version='masked-v1'
         GROUP BY 1`,
        args
      ),
      mskdMint
        ? this.db.query<{ day: string; n: number; lamports: string; tokens: string }>(
            `SELECT ${day('created_at')} AS day,count(*)::int AS n,sum(actual_spent_lamports)::text AS lamports,
               sum(burned_tokens)::text AS tokens
             FROM wallet_settlements WHERE network_genesis=$1 AND created_at>=$2 AND kind='buyback' AND mint=$3
             GROUP BY 1`,
            [...args, mskdMint]
          )
        : Promise.resolve({ rows: [] }),
      this.db.query<{ day: string; lamports: string }>(
        `SELECT ${day('s.created_at')} AS day,sum(s.paid_lamports)::text AS lamports
         FROM wallet_settlements s JOIN launch_coins c ON(c.network_genesis=s.network_genesis AND c.mint=s.mint)
         WHERE s.network_genesis=$1 AND s.created_at>=$2 AND s.kind IN('creator_claim','community_claim')
           AND c.policy_version='masked-v1'
         GROUP BY 1`,
        args
      ),
      this.db.query<{ day: string; lamports: string; units: string }>(
        `SELECT ${day('created_at')} AS day,sum(lamports)::text AS lamports,sum(payout_units)::text AS units
         FROM masked_wxmr_payments WHERE network_genesis=$1 AND created_at>=$2 GROUP BY 1`,
        args
      ),
      this.db.query<{ day: string; lamports: string; atomic: string }>(
        `SELECT day,sum(lamports)::text AS lamports,sum(xmr_atomic)::text AS atomic FROM (
           SELECT DISTINCT ${day('x.settled_at')} AS day,m.id,m.lamports,m.xmr_atomic
           FROM masked_xmr_settlements x JOIN masked_claims m ON m.id=x.claim_id
           WHERE x.network_genesis=$1 AND x.settled_at>=$2) paid GROUP BY day`,
        args
      ),
      this.db.query<{ day: string; hash: string }>(
        `SELECT DISTINCT ${day('x.settled_at')} AS day,unnest(b.tx_hashes) AS hash
         FROM masked_xmr_settlements x JOIN masked_xmr_batches b ON b.id=x.batch_id
         WHERE x.network_genesis=$1 AND x.settled_at>=$2 ORDER BY 1,2`,
        args
      ),
      this.db.query<{ day: string; atomic: string }>(
        `SELECT ${day('received_at')} AS day,sum(amount_atomic)::text AS atomic
         FROM masked_xmr_inflows WHERE network_genesis=$1 AND received_at>=$2 GROUP BY 1`,
        args
      ),
      this.db.query<{ day: string; n: number }>(
        `SELECT day,count(DISTINCT wallet)::int AS n FROM (
           SELECT ${day('s.created_at')} AS day,j.recipient AS wallet
           FROM wallet_settlements s JOIN wallet_jobs j ON j.id=s.job_id
           JOIN launch_coins c ON(c.network_genesis=s.network_genesis AND c.mint=s.mint)
           WHERE s.network_genesis=$1 AND s.created_at>=$2 AND s.kind IN('creator_claim','community_claim')
             AND c.policy_version='masked-v1'
           UNION ALL
           SELECT ${day('created_at')},recipient FROM masked_wxmr_payments WHERE network_genesis=$1 AND created_at>=$2
           UNION ALL
           SELECT ${day('x.settled_at')},m.wallet FROM masked_xmr_settlements x JOIN masked_claims m ON m.id=x.claim_id
           WHERE x.network_genesis=$1 AND x.settled_at>=$2
         ) paid GROUP BY day`,
        args
      ),
    ]);
    const days = new Map<string, ProofDay>();
    const at = (date: string) => {
      let value = days.get(date);
      if (!value) days.set(date, (value = emptyDay(date)));
      return value;
    };
    for (const row of collect.rows)
      Object.assign(at(row.day), { collections: row.n, feesCollectedLamports: row.lamports });
    for (const row of burns.rows)
      Object.assign(at(row.day), {
        burns: row.n,
        mskdBoughtLamports: row.lamports,
        mskdBurnedTokens: row.tokens,
      });
    for (const row of sol.rows) at(row.day).solPaidLamports = row.lamports;
    for (const row of wxmr.rows)
      Object.assign(at(row.day), { wxmrPaidLamports: row.lamports, wxmrPaidAtomic: row.units });
    for (const row of xmr.rows)
      Object.assign(at(row.day), { xmrPaidLamports: row.lamports, xmrPaidAtomic: row.atomic });
    for (const row of xmrTx.rows) at(row.day).xmrTransactions.push(row.hash);
    for (const row of inflows.rows) at(row.day).xmrReceivedAtomic = row.atomic;
    for (const row of people.rows) at(row.day).peoplePaid = row.n;
    return [...days.values()].sort((a, b) => b.day.localeCompare(a.day));
  }

  /** Company-wallet transactions only: fee collections and $MSKD burns. */
  async receipts(network: string, mskdMint: string | null) {
    const collections = await this.db.query<ProofReceipt>(
      `SELECT s.signature,s.created_at AS at,s.received_lamports::text AS lamports
       FROM wallet_settlements s JOIN launch_coins c ON(c.network_genesis=s.network_genesis AND c.mint=s.mint)
       WHERE s.network_genesis=$1 AND s.kind='collect' AND c.policy_version='masked-v1'
       ORDER BY s.created_at DESC LIMIT ${RECEIPTS}`,
      [network]
    );
    const burns = mskdMint
      ? await this.db.query<ProofReceipt>(
          `SELECT signature,created_at AS at,actual_spent_lamports::text AS lamports,burned_tokens::text AS tokens
           FROM wallet_settlements WHERE network_genesis=$1 AND kind='buyback' AND mint=$2
           ORDER BY created_at DESC LIMIT ${RECEIPTS}`,
          [network, mskdMint]
        )
      : { rows: [] as ProofReceipt[] };
    const iso = (row: ProofReceipt) => ({ ...row, at: new Date(row.at).toISOString() });
    return { collections: collections.rows.map(iso), burns: burns.rows.map(iso) };
  }

  /** One finalized $MSKD burn and its running totals; null when the signature is not a burn. */
  async burn(network: string, mskdMint: string, signature: string) {
    const row = (
      await this.db.query<{
        signature: string;
        at: Date;
        slot: string;
        lamports: string;
        tokens: string;
        pool: string | null;
        route: string | null;
        number: number;
        total: number;
        burned: string;
        funded: string;
      }>(
        `WITH burns AS (
           SELECT s.signature,s.created_at,s.finalized_slot,s.actual_spent_lamports,s.burned_tokens,
             j.expectations->>'pool' AS pool,j.expectations->>'route' AS route,
             row_number() OVER(ORDER BY s.created_at,s.signature)::int AS number,
             count(*) OVER()::int AS total,
             sum(s.burned_tokens) OVER(ORDER BY s.created_at,s.signature) AS burned
           FROM wallet_settlements s JOIN wallet_jobs j ON j.id=s.job_id
           WHERE s.network_genesis=$1 AND s.mint=$2 AND s.kind='buyback')
         SELECT b.signature,b.created_at AS at,b.finalized_slot::text AS slot,
           b.actual_spent_lamports::text AS lamports,b.burned_tokens::text AS tokens,b.pool,b.route,
           b.number,b.total,b.burned::text AS burned,
           (SELECT coalesce(sum(t.lamports),0) FROM masked_mskd_buyback_transfers t
             WHERE t.network_genesis=$1 AND t.target_mint=$2 AND t.created_at<=b.created_at)::text AS funded
         FROM burns b WHERE b.signature=$3`,
        [network, mskdMint, signature]
      )
    ).rows[0];
    if (!row) return null;
    return {
      signature: row.signature,
      at: new Date(row.at).toISOString(),
      slot: row.slot,
      lamports: row.lamports,
      tokens: row.tokens,
      pool: row.pool,
      route: row.route,
      number: row.number,
      totalBurns: row.total,
      burnedToDateTokens: row.burned,
      fundedByMaskedLamports: row.funded,
      mint: mskdMint,
    };
  }

  async xmrReserves(network: string) {
    const [status, waiting] = await Promise.all([
      this.db.query<{ unlocked: string; heartbeat_at: Date }>(
        'SELECT unlocked_atomic::text AS unlocked,heartbeat_at FROM masked_payout_status WHERE network_genesis=$1',
        [network]
      ),
      this.db.query<{ n: number; lamports: string }>(
        `SELECT count(*)::int AS n,coalesce(sum(lamports),0)::text AS lamports FROM masked_claims
         WHERE network_genesis=$1 AND currency='xmr' AND status IN('queued','batched','sent')`,
        [network]
      ),
    ]);
    const row = status.rows[0];
    return {
      xmrUnlockedAtomic: row?.unlocked ?? null,
      xmrHeartbeatAt: row ? new Date(row.heartbeat_at).toISOString() : null,
      xmrClaimsWaiting: waiting.rows[0]!.n,
      xmrClaimsWaitingLamports: waiting.rows[0]!.lamports,
    };
  }

  async treasury(network: string, moneroNetwork: MoneroNetwork): Promise<ProofView['treasury']> {
    const [keys, exported] = await Promise.all([
      this.db.query<{
        primary_address: string;
        view_key: string;
        restore_height: string | null;
        published_at: Date;
      }>(
        'SELECT primary_address,view_key,restore_height::text,published_at FROM masked_treasury_keys WHERE network_genesis=$1',
        [network]
      ),
      this.db.query<{ count: number; height: string; created_at: Date; digest: string }>(
        `SELECT key_image_count AS count,wallet_height::text AS height,created_at,digest FROM masked_key_image_exports
         WHERE network_genesis=$1 ORDER BY created_at DESC LIMIT 1`,
        [network]
      ),
    ]);
    const key = keys.rows[0];
    if (!key) return null;
    const last = exported.rows[0];
    return {
      address: key.primary_address,
      viewKey: key.view_key,
      restoreHeight: key.restore_height,
      verified: viewKeyMatchesAddress(key.primary_address, key.view_key, moneroNetwork),
      publishedAt: new Date(key.published_at).toISOString(),
      keyImages: last
        ? {
            count: last.count,
            walletHeight: last.height,
            exportedAt: new Date(last.created_at).toISOString(),
            digest: last.digest,
          }
        : null,
    };
  }

  /** The newest signed key images, in the shape monero-wallet-rpc's import_key_images takes. */
  async latestKeyImages(network: string) {
    const row = (
      await this.db.query<{ export_offset: number; payload: unknown; digest: string }>(
        `SELECT export_offset,payload,digest FROM masked_key_image_exports WHERE network_genesis=$1
         ORDER BY created_at DESC LIMIT 1`,
        [network]
      )
    ).rows[0];
    return row
      ? { offset: row.export_offset, signed_key_images: row.payload, digest: row.digest }
      : null;
  }

  async controls(
    network: string,
    wallets: { collector: string; treasury: string } | null,
    mskdMint: string | null,
    moneroAddress: string | null
  ): Promise<ProofControl[]> {
    const configs = (
      await this.db.query<{ config_key: string }>(
        `SELECT config_key FROM launch_configs WHERE network_genesis=$1 AND policy_version='masked-v1' ORDER BY config_key`,
        [network]
      )
    ).rows;
    const controls: ProofControl[] = [];
    if (wallets)
      controls.push(
        {
          label: 'Company fee wallet',
          address: wallets.collector,
          kind: 'solana',
          role: 'Claims trading fees from every Masked pool and pays SOL and wXMR claims and $MSKD buybacks. Its key is held only by a separate signing service, never by the website.',
        },
        {
          label: 'Company treasury',
          address: wallets.treasury,
          kind: 'solana',
          role: 'Receives the company’s 0.30% share. The SOL behind XMR payouts is swept here to buy more XMR.',
        }
      );
    for (const config of configs)
      controls.push({
        label: 'Masked launch config',
        address: config.config_key,
        kind: 'solana',
        role: 'Fixes every Masked pool’s fee rate and fee wallet at launch. Each coin’s creator share is locked in when it launches.',
      });
    if (mskdMint)
      controls.push({
        label: '$MSKD token',
        address: mskdMint,
        kind: 'solana',
        role: 'Bought back with 0.10% of every trade and burned.',
      });
    if (moneroAddress)
      controls.push({
        label: 'Monero treasury',
        address: moneroAddress,
        kind: 'monero',
        role: 'Pays every XMR claim. Its view key is published on this page, so anyone can see what it receives and, with the key images, what it spends.',
      });
    controls.push(
      {
        label: 'Meteora bonding curve program',
        address: DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58(),
        kind: 'solana',
        role: 'Holds every Masked coin’s bonding curve until it graduates. Run by Meteora, not by Masked.',
      },
      {
        label: 'Meteora DAMM v2 program',
        address: CP_AMM_PROGRAM_ID.toBase58(),
        kind: 'solana',
        role: 'Holds every graduated Masked pool. Run by Meteora, not by Masked.',
      }
    );
    return controls;
  }
}
