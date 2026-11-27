// Display index storage. One indexer writes; every web request reads. Display data only:
// payouts and claims keep their own finalized ledger and never read these tables.
import {
  COIN_CHART_BUCKET_SECONDS,
  COIN_CHART_SECONDS,
  type Coin,
  type CoinPriceHistory,
  type Holder,
  type HoldersResponse,
  type Trade,
} from '@/lib/coin';
import { computePot, type PotSummary } from '@/lib/pot';
import { summarizeMarket, type TokenMarket } from '@/lib/market';
import { LAUNCH_TAX_WINDOW_SECONDS, TOTAL_SUPPLY } from '@/constants/launch';

export type Queryable = {
  query: <R = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<{ rows: R[] }>;
};
/** A pool hands out one client per transaction; a single connection is its own transaction scope. */
export type Database = Queryable & {
  connect?: () => Promise<Queryable & { release: () => void }>;
};

/** Web processes ask the indexer to read a coin now, e.g. right after a launch is confirmed. */
export const TOUCH_CHANNEL = 'display_index_touch';
/** One channel; payloads are `<kind>:<mint>` or `board`. */
export const DISPLAY_CHANNEL = 'display_index';
export type DisplayEvent =
  { kind: 'coin' | 'trades' | 'holders'; mint: string } | { kind: 'board' };
export const encodeEvent = (event: DisplayEvent) =>
  event.kind === 'board' ? 'board' : `${event.kind}:${event.mint}`;
export function decodeEvent(payload: string): DisplayEvent | null {
  if (payload === 'board') return { kind: 'board' };
  const [kind, mint] = payload.split(':');
  if (
    (kind === 'coin' || kind === 'trades' || kind === 'holders') &&
    mint &&
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)
  )
    return { kind, mint };
  return null;
}

/** Index rows hold amounts in the pool's quote asset; hSOL pools convert to SOL on read. */
export type IndexedTrade = Trade & { slot: number; pool: string };

type TradeRow = {
  signature: string;
  instruction_index: number;
  event_index: number;
  ts: string;
  side: 'buy' | 'sell';
  wallet: string;
  wallet_role: 'token-owner' | 'swap-authority';
  quote_amount: number;
  tokens: number;
  fee_quote: number;
  fee_is_estimate: boolean;
  price_quote: number;
  route: 'dbc' | 'damm-v2';
};

const STALE_AFTER_MS = 150_000;

export class DisplayStore {
  constructor(
    private db: Database,
    readonly genesis: string
  ) {}

  private notify(events: DisplayEvent[]) {
    const unique = [...new Set(events.map(encodeEvent))];
    if (!unique.length) return Promise.resolve();
    return this.db.query(
      `SELECT pg_notify('${DISPLAY_CHANNEL}', payload) FROM unnest($1::text[]) AS payload`,
      [unique]
    );
  }

  /** Writes coins whose display changed and announces them. Returns the changed mints. */
  async upsertCoins(coins: Coin[]): Promise<string[]> {
    if (!coins.length) return [];
    const rows = await this.db.query<{ mint: string; inserted: boolean }>(
      `INSERT INTO display_coins(network_genesis,mint,pool,migrated_pool,coin,launched_at,market_cap_sol,is_migrated,updated_at)
       SELECT $1,c->>'mint',c->>'pool',c->>'migratedPool',c,(c->>'launchedAt')::bigint,
              greatest((c->>'marketCapSol')::double precision,0),(c->>'isMigrated')::boolean,now()
       FROM jsonb_array_elements($2::jsonb) AS c
       ON CONFLICT(network_genesis,mint) DO UPDATE SET pool=EXCLUDED.pool,migrated_pool=EXCLUDED.migrated_pool,
         coin=EXCLUDED.coin,launched_at=EXCLUDED.launched_at,market_cap_sol=EXCLUDED.market_cap_sol,
         is_migrated=EXCLUDED.is_migrated,updated_at=now()
       WHERE display_coins.coin IS DISTINCT FROM EXCLUDED.coin
       RETURNING mint,(xmax=0) AS inserted`,
      [this.genesis, JSON.stringify(coins)]
    );
    const changed = rows.rows.map((row) => row.mint);
    // Updates travel as coin events; only a new coin changes the board's list.
    await this.notify([
      ...changed.map((mint) => ({ kind: 'coin' as const, mint })),
      ...(rows.rows.some((row) => row.inserted) ? [{ kind: 'board' as const }] : []),
    ]);
    return changed;
  }

  /** Coins that left discovery stay in history but leave the board. */
  async removeCoinsExcept(mints: string[]) {
    const removed = await this.db.query<{ mint: string }>(
      'DELETE FROM display_coins WHERE network_genesis=$1 AND NOT (mint=ANY($2::varchar[])) RETURNING mint',
      [this.genesis, mints]
    );
    if (removed.rows.length) await this.notify([{ kind: 'board' }]);
  }

  async insertTrades(mint: string, trades: IndexedTrade[]) {
    if (!trades.length) return 0;
    const inserted = await this.db.query<{ signature: string }>(
      `INSERT INTO display_trades(network_genesis,signature,instruction_index,event_index,mint,pool,slot,ts,side,wallet,wallet_role,
         quote_amount,tokens,fee_quote,fee_is_estimate,price_quote,route)
       SELECT $1,t->>'sig',(t->>'instructionIndex')::int,(t->>'eventIndex')::int,$2,t->>'pool',(t->>'slot')::bigint,
         (t->>'ts')::bigint,t->>'side',t->>'wallet',coalesce(t->>'walletRole','swap-authority'),(t->>'sol')::double precision,
         (t->>'tokens')::double precision,(t->>'feeSol')::double precision,coalesce((t->>'feeSolIsEstimate')::boolean,false),
         (t->>'priceSol')::double precision,coalesce(t->>'route','dbc')
       FROM jsonb_array_elements($3::jsonb) AS t
       ON CONFLICT DO NOTHING RETURNING signature`,
      [this.genesis, mint, JSON.stringify(trades)]
    );
    if (inserted.rows.length) await this.notify([{ kind: 'trades', mint }]);
    return inserted.rows.length;
  }

  async cursor(pool: string) {
    return (
      await this.db.query<{
        newest_signature: string | null;
        backfill_before: string | null;
        backfill_complete: boolean;
        forward_head: string | null;
        forward_before: string | null;
      }>(
        'SELECT newest_signature,backfill_before,backfill_complete,forward_head,forward_before FROM display_pool_cursors WHERE network_genesis=$1 AND pool=$2',
        [this.genesis, pool]
      )
    ).rows[0];
  }

  async saveCursor(
    pool: string,
    mint: string,
    cursor: {
      newest: string | null;
      backfillBefore: string | null;
      complete: boolean;
      forwardHead: string | null;
      forwardBefore: string | null;
    }
  ) {
    await this.db.query(
      `INSERT INTO display_pool_cursors(network_genesis,pool,mint,newest_signature,backfill_before,backfill_complete,forward_head,forward_before,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,now())
       ON CONFLICT(network_genesis,pool) DO UPDATE SET newest_signature=EXCLUDED.newest_signature,
         backfill_before=EXCLUDED.backfill_before,backfill_complete=EXCLUDED.backfill_complete,
         forward_head=EXCLUDED.forward_head,forward_before=EXCLUDED.forward_before,updated_at=now()`,
      [
        this.genesis,
        pool,
        mint,
        cursor.newest,
        cursor.backfillBefore,
        cursor.complete,
        cursor.forwardHead,
        cursor.forwardBefore,
      ]
    );
  }

  /** Replaces a coin's holder list as one snapshot. Amounts are raw token units. */
  async replaceHolders(
    mint: string,
    scan: {
      slot: number;
      decimals: number;
      supply: bigint;
      excluded: bigint;
      holders: Map<string, bigint>;
    }
  ) {
    const owners = [...scan.holders].filter(([, amount]) => amount > 0n);
    const client = this.db.connect ? await this.db.connect() : null,
      tx: Queryable = client ?? this.db;
    try {
      await tx.query('BEGIN');
      const previous = (
        await tx.query<{ slot: string }>(
          'SELECT slot::text FROM display_holder_scans WHERE network_genesis=$1 AND mint=$2 FOR UPDATE',
          [this.genesis, mint]
        )
      ).rows[0];
      // A slower scan never overwrites a newer one.
      if (previous && BigInt(previous.slot) > BigInt(scan.slot)) {
        await tx.query('ROLLBACK');
        return false;
      }
      await tx.query('DELETE FROM display_holders WHERE network_genesis=$1 AND mint=$2', [
        this.genesis,
        mint,
      ]);
      if (owners.length)
        await tx.query(
          `INSERT INTO display_holders(network_genesis,mint,owner,amount)
           SELECT $1,$2,o,a::numeric FROM unnest($3::text[],$4::text[]) AS h(o,a)`,
          [
            this.genesis,
            mint,
            owners.map(([owner]) => owner),
            owners.map(([, amount]) => amount.toString()),
          ]
        );
      await tx.query(
        `INSERT INTO display_holder_scans(network_genesis,mint,slot,decimals,supply,excluded,holder_count,scanned_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,now())
         ON CONFLICT(network_genesis,mint) DO UPDATE SET slot=EXCLUDED.slot,decimals=EXCLUDED.decimals,supply=EXCLUDED.supply,
           excluded=EXCLUDED.excluded,holder_count=EXCLUDED.holder_count,scanned_at=now()`,
        [
          this.genesis,
          mint,
          scan.slot,
          scan.decimals,
          scan.supply.toString(),
          scan.excluded.toString(),
          owners.length,
        ]
      );
      await tx.query('COMMIT');
    } catch (error) {
      await tx.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client?.release();
    }
    await this.notify([{ kind: 'holders', mint }]);
    return true;
  }

  async heartbeat(network: {
    slot: number | null;
    chainTime: number | null;
    tps: number | null;
    rpcMs: number | null;
  }) {
    await this.db.query(
      `INSERT INTO display_indexer_status(network_genesis,heartbeat_at,slot,chain_time,tps,rpc_ms) VALUES($1,now(),$2,$3,$4,$5)
       ON CONFLICT(network_genesis) DO UPDATE SET heartbeat_at=now(),slot=EXCLUDED.slot,chain_time=EXCLUDED.chain_time,
         tps=EXCLUDED.tps,rpc_ms=EXCLUDED.rpc_ms`,
      [
        this.genesis,
        network.slot,
        network.chainTime,
        network.tps,
        network.rpcMs === null ? null : Math.round(network.rpcMs),
      ]
    );
  }

  // ---- Reads ----

  async status() {
    const row = (
      await this.db.query<{
        age_ms: number;
        slot: string | null;
        chain_time: string | null;
        tps: number | null;
        rpc_ms: number | null;
      }>(
        `SELECT extract(epoch FROM now()-heartbeat_at)*1000 AS age_ms,slot::text,chain_time::text,tps,rpc_ms
         FROM display_indexer_status WHERE network_genesis=$1`,
        [this.genesis]
      )
    ).rows[0];
    const stale = !row || Number(row.age_ms) > STALE_AFTER_MS;
    return {
      stale,
      /** Chain time advanced by the heartbeat's age; zero when unknown, never the host clock alone. */
      chainTime:
        row?.chain_time && !stale
          ? Number(row.chain_time) + Math.floor(Number(row.age_ms) / 1000)
          : 0,
      network: {
        slot: row?.slot ? Number(row.slot) : null,
        tps: row?.tps ?? null,
        rpcMs: row?.rpc_ms ?? null,
      },
    };
  }

  async coins(): Promise<Coin[]> {
    return (
      await this.db.query<{ coin: Coin }>(
        'SELECT coin FROM display_coins WHERE network_genesis=$1 ORDER BY launched_at DESC,mint',
        [this.genesis]
      )
    ).rows.map((row) => row.coin);
  }

  async coin(mint: string): Promise<Coin | null> {
    return (
      (
        await this.db.query<{ coin: Coin }>(
          'SELECT coin FROM display_coins WHERE network_genesis=$1 AND mint=$2',
          [this.genesis, mint]
        )
      ).rows[0]?.coin ?? null
    );
  }

  /** Newest trades first, converted to SOL and the coin's current supply. */
  async trades(coin: Coin, limit: number): Promise<{ trades: Trade[]; complete: boolean }> {
    const [rows, cursors] = await Promise.all([
      this.db.query<TradeRow>(
        `SELECT signature,instruction_index,event_index,ts::text,side,wallet,wallet_role,quote_amount,tokens,fee_quote,
           fee_is_estimate,price_quote,route FROM display_trades WHERE network_genesis=$1 AND mint=$2
         ORDER BY ts DESC,slot DESC,signature DESC,instruction_index DESC,event_index DESC LIMIT $3`,
        [this.genesis, coin.mint, limit + 1]
      ),
      this.db.query<{ complete: boolean }>(
        'SELECT backfill_complete AND forward_head IS NULL AS complete FROM display_pool_cursors WHERE network_genesis=$1 AND mint=$2',
        [this.genesis, coin.mint]
      ),
    ]);
    const pools = coin.migratedPool ? 2 : 1;
    return {
      trades: rows.rows.slice(0, limit).map((row) => toTrade(row, coin)),
      complete:
        rows.rows.length <= limit &&
        cursors.rows.length >= pools &&
        cursors.rows.every((row) => row.complete),
    };
  }

  async prices(
    coin: Coin,
    now = Math.floor(Date.now() / 1000)
  ): Promise<CoinPriceHistory['points']> {
    const { rows } = await this.db.query<{ time: string; price_quote: number }>(
      `SELECT DISTINCT ON (ts/$5::bigint) ts::text AS time,price_quote FROM display_trades
       WHERE network_genesis=$1 AND mint=$2 AND ts BETWEEN $3 AND $4
       ORDER BY ts/$5::bigint,ts DESC,slot DESC,signature DESC,instruction_index DESC,event_index DESC`,
      [this.genesis, coin.mint, now - COIN_CHART_SECONDS, now, COIN_CHART_BUCKET_SECONDS]
    );
    return rows.map((row) => ({
      time: Number(row.time),
      priceSol: row.price_quote * (coin.quoteToSol ?? 1),
    }));
  }

  /** Fees over the whole history plus launch-window tax, without loading every trade. */
  async pot(coin: Coin): Promise<PotSummary> {
    const [window, totals] = await Promise.all([
      this.db.query<TradeRow>(
        `SELECT signature,instruction_index,event_index,ts::text,side,wallet,wallet_role,quote_amount,tokens,fee_quote,
           fee_is_estimate,price_quote,route FROM display_trades WHERE network_genesis=$1 AND mint=$2 AND ts<=$3`,
        [this.genesis, coin.mint, coin.launchedAt + LAUNCH_TAX_WINDOW_SECONDS]
      ),
      this.db.query<{ fees: number | null }>(
        'SELECT sum(fee_quote) AS fees FROM display_trades WHERE network_genesis=$1 AND mint=$2',
        [this.genesis, coin.mint]
      ),
    ]);
    const launch = computePot(
      window.rows.map((row) => toTrade(row, coin)),
      coin.launchedAt
    );
    return { ...launch, feesSol: Number(totals.rows[0]?.fees ?? 0) * (coin.quoteToSol ?? 1) };
  }

  async holders(coin: Coin, limit = 1000): Promise<HoldersResponse | null> {
    const scan = (
      await this.db.query<{
        slot: string;
        decimals: number;
        supply: string;
        excluded: string;
        holder_count: number;
        at: string;
      }>(
        `SELECT slot::text,decimals,supply::text,excluded::text,holder_count,extract(epoch FROM scanned_at)::bigint::text AS at
         FROM display_holder_scans WHERE network_genesis=$1 AND mint=$2`,
        [this.genesis, coin.mint]
      )
    ).rows[0];
    if (!scan) return null;
    const rows = await this.db.query<{ owner: string; amount: string }>(
      `SELECT owner,amount::text FROM display_holders WHERE network_genesis=$1 AND mint=$2
       ORDER BY amount DESC,owner LIMIT $3`,
      [this.genesis, coin.mint, limit]
    );
    const scale = 10 ** scan.decimals,
      supply = BigInt(scan.supply),
      circulating = supply - BigInt(scan.excluded);
    const holders: Holder[] = rows.rows.map(({ owner, amount }) => {
      const raw = BigInt(amount);
      return {
        owner,
        amount: Number(raw) / scale,
        shareOfCirculating: circulating > 0n ? Number(raw) / Number(circulating) : 0,
        shareOfSupply: supply > 0n ? Number(raw) / Number(supply) : 0,
        isCreator: owner === coin.creator,
      };
    });
    return {
      holders,
      circulating: Number(circulating) / scale,
      tokenSupply: Number(supply) / scale,
      excludedSupply: Number(BigInt(scan.excluded)) / scale,
      holderCount: scan.holder_count,
      partial: scan.holder_count > holders.length,
      snapshotSlot: Number(scan.slot),
      updatedAt: Number(scan.at),
      stale: Date.now() / 1000 - Number(scan.at) > 2 * 3600,
    };
  }

  /** 24-hour figures for every coin from indexed trades. */
  async markets(coins: Coin[], now = Math.floor(Date.now() / 1000)) {
    const rows = await this.db.query<TradeRow & { mint: string }>(
      `SELECT mint,signature,instruction_index,event_index,ts::text,side,wallet,wallet_role,quote_amount,tokens,fee_quote,
         fee_is_estimate,price_quote,route FROM display_trades WHERE network_genesis=$1 AND ts>=$2 ORDER BY ts`,
      [this.genesis, now - 86_400]
    );
    const byMint = new Map<string, TradeRow[]>();
    for (const row of rows.rows) {
      const market = byMint.get(row.mint);
      if (market) market.push(row);
      else byMint.set(row.mint, [row]);
    }
    const tokens: Record<string, TokenMarket> = {};
    for (const coin of coins)
      tokens[coin.mint] = summarizeMarket(
        (byMint.get(coin.mint) ?? []).map((row) => toTrade(row, coin)),
        coin.marketCapSol,
        false,
        now
      );
    return tokens;
  }

  /** Swaps per coin in the last window, for trending. */
  async recentSwapCounts(seconds: number, now = Math.floor(Date.now() / 1000)) {
    const rows = await this.db.query<{ mint: string; count: string }>(
      `SELECT mint,count(DISTINCT signature)::text AS count FROM display_trades
       WHERE network_genesis=$1 AND ts>=$2 GROUP BY mint`,
      [this.genesis, now - seconds]
    );
    return new Map(rows.rows.map((row) => [row.mint, Number(row.count)]));
  }
}

function toTrade(row: TradeRow, coin: Coin): Trade {
  const rate = coin.quoteToSol ?? 1,
    priceSol = row.price_quote * rate;
  return {
    id: `${row.signature}:${row.instruction_index}:${row.event_index}`,
    sig: row.signature,
    instructionIndex: row.instruction_index,
    eventIndex: row.event_index,
    ts: Number(row.ts),
    side: row.side,
    wallet: row.wallet,
    walletRole: row.wallet_role,
    sol: row.quote_amount * rate,
    tokens: row.tokens,
    feeSol: row.fee_quote * rate,
    feeSolIsEstimate: row.fee_is_estimate,
    route: row.route,
    priceSol,
    marketCapSol: priceSol * (coin.tokenSupply ?? TOTAL_SUPPLY),
  };
}
