-- Display index: what the website shows, written by one indexer and read by every web request.
-- Display data only. Payouts and claims never read these tables; they keep their finalized ledger.

-- Latest state of every coin on the board, as the website renders it.
CREATE TABLE IF NOT EXISTS display_coins(
 network_genesis text NOT NULL,
 mint varchar(44) NOT NULL,
 pool varchar(44) NOT NULL,
 migrated_pool varchar(44),
 coin jsonb NOT NULL CHECK(jsonb_typeof(coin)='object'),
 launched_at bigint NOT NULL CHECK(launched_at>=0),
 market_cap_sol double precision NOT NULL CHECK(market_cap_sol>=0),
 is_migrated boolean NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(network_genesis,mint)
);
CREATE INDEX IF NOT EXISTS display_coins_launched ON display_coins(network_genesis,launched_at DESC);

-- Every decoded swap on a coin's bonding curve and graduated pool. Amounts are in the pool's
-- quote asset; the reader converts hSOL pools to SOL with the coin's current rate.
CREATE TABLE IF NOT EXISTS display_trades(
 network_genesis text NOT NULL,
 signature varchar(88) NOT NULL,
 instruction_index integer NOT NULL CHECK(instruction_index>=0),
 event_index integer NOT NULL CHECK(event_index>=0),
 mint varchar(44) NOT NULL,
 pool varchar(44) NOT NULL,
 slot bigint NOT NULL CHECK(slot>=0),
 ts bigint NOT NULL CHECK(ts>=0),
 side text NOT NULL CHECK(side IN('buy','sell')),
 wallet varchar(44) NOT NULL,
 wallet_role text NOT NULL CHECK(wallet_role IN('token-owner','swap-authority')),
 quote_amount double precision NOT NULL CHECK(quote_amount>=0),
 tokens double precision NOT NULL CHECK(tokens>=0),
 fee_quote double precision NOT NULL CHECK(fee_quote>=0),
 fee_is_estimate boolean NOT NULL,
 price_quote double precision NOT NULL CHECK(price_quote>0),
 route text NOT NULL CHECK(route IN('dbc','damm-v2')),
 PRIMARY KEY(network_genesis,signature,instruction_index,event_index)
);
CREATE INDEX IF NOT EXISTS display_trades_mint ON display_trades(network_genesis,mint,ts DESC,slot DESC);
CREATE INDEX IF NOT EXISTS display_trades_recent ON display_trades(network_genesis,ts DESC);

-- How far each pool's history has been read: newest seen signature, and an older boundary
-- while the first backfill is still walking back to the pool's creation.
CREATE TABLE IF NOT EXISTS display_pool_cursors(
 network_genesis text NOT NULL,
 pool varchar(44) NOT NULL,
 mint varchar(44) NOT NULL,
 newest_signature varchar(88),
 backfill_before varchar(88),
 backfill_complete boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(network_genesis,pool)
);

-- Full holder list per coin from a complete token-account scan, replaced as a whole.
CREATE TABLE IF NOT EXISTS display_holders(
 network_genesis text NOT NULL,
 mint varchar(44) NOT NULL,
 owner varchar(44) NOT NULL,
 amount numeric(39,0) NOT NULL CHECK(amount>0),
 PRIMARY KEY(network_genesis,mint,owner)
);
CREATE INDEX IF NOT EXISTS display_holders_amount ON display_holders(network_genesis,mint,amount DESC);
CREATE TABLE IF NOT EXISTS display_holder_scans(
 network_genesis text NOT NULL,
 mint varchar(44) NOT NULL,
 slot bigint NOT NULL CHECK(slot>=0),
 decimals smallint NOT NULL CHECK(decimals BETWEEN 0 AND 18),
 supply numeric(39,0) NOT NULL CHECK(supply>=0),
 excluded numeric(39,0) NOT NULL CHECK(excluded>=0 AND excluded<=supply),
 holder_count integer NOT NULL CHECK(holder_count>=0),
 scanned_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(network_genesis,mint)
);

-- Indexer liveness and the network figures it samples, so web requests never call the RPC for them.
CREATE TABLE IF NOT EXISTS display_indexer_status(
 network_genesis text PRIMARY KEY,
 heartbeat_at timestamptz NOT NULL,
 slot bigint,
 chain_time bigint,
 tps double precision,
 rpc_ms integer
);
