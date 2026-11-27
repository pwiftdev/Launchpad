-- Daily XMR payouts. A batch locks one SOL->XMR rate, signs every Monero transaction and stores
-- them before relaying, so a crash can only resend the same transactions, never pay twice.
-- After enough confirmations the claims are paid, their addresses erased, and the SOL behind
-- them becomes company income that the existing treasury sweep withdraws.
CREATE TABLE IF NOT EXISTS masked_xmr_batches(
 id uuid PRIMARY KEY,
 network_genesis text NOT NULL,
 status text NOT NULL DEFAULT 'planned' CHECK(status IN('planned','signed','sent','paid','failed')),
 -- Piconero paid per whole SOL of earnings, after the stated fee.
 rate_atomic_per_sol numeric(39,0) NOT NULL CHECK(rate_atomic_per_sol>0),
 fee_bps integer NOT NULL CHECK(fee_bps BETWEEN 0 AND 1000),
 price_source text NOT NULL CHECK(length(price_source) BETWEEN 1 AND 200),
 sol_usd double precision NOT NULL CHECK(sol_usd>0),
 xmr_usd double precision NOT NULL CHECK(xmr_usd>0),
 total_atomic numeric(39,0) NOT NULL CHECK(total_atomic>0),
 network_fee_atomic numeric(39,0) CHECK(network_fee_atomic IS NULL OR network_fee_atomic>=0),
 tx_hashes text[] NOT NULL DEFAULT '{}',
 -- Signed transactions, kept until the batch settles so a resend is always the same payment.
 tx_metadata text[],
 failure text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(status IN('planned','failed') OR cardinality(tx_hashes)>0),
 CHECK(status NOT IN('signed','sent') OR tx_metadata IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS masked_xmr_batches_one_open ON masked_xmr_batches(network_genesis)
 WHERE status IN('planned','signed','sent');
ALTER TABLE masked_claims DROP CONSTRAINT IF EXISTS masked_claims_batch;
ALTER TABLE masked_claims ADD CONSTRAINT masked_claims_batch FOREIGN KEY(batch_id) REFERENCES masked_xmr_batches(id);

CREATE OR REPLACE FUNCTION masked_batch_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'XMR batches are permanent'; END IF;
 IF (NEW.id,NEW.network_genesis,NEW.rate_atomic_per_sol,NEW.fee_bps,NEW.price_source,NEW.sol_usd,NEW.xmr_usd,NEW.total_atomic,NEW.created_at)
    IS DISTINCT FROM
    (OLD.id,OLD.network_genesis,OLD.rate_atomic_per_sol,OLD.fee_bps,OLD.price_source,OLD.sol_usd,OLD.xmr_usd,OLD.total_atomic,OLD.created_at)
 THEN RAISE EXCEPTION 'XMR batch terms are immutable'; END IF;
 IF OLD.status IN('paid','failed') AND NEW.status IS DISTINCT FROM OLD.status THEN
  RAISE EXCEPTION 'A settled XMR batch cannot change';
 END IF;
 IF cardinality(OLD.tx_hashes)>0 AND NEW.tx_hashes IS DISTINCT FROM OLD.tx_hashes THEN
  RAISE EXCEPTION 'Signed XMR transactions cannot be replaced';
 END IF;
 NEW.updated_at=now();
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS masked_xmr_batches_transition ON masked_xmr_batches;
CREATE TRIGGER masked_xmr_batches_transition BEFORE UPDATE OR DELETE ON masked_xmr_batches
 FOR EACH ROW EXECUTE FUNCTION masked_batch_transition();

-- How each paid claim left the payout ledger: the reserved creator or holder amount is spent,
-- and the same SOL is credited to the coin's platform share for the treasury sweep.
CREATE TABLE IF NOT EXISTS masked_xmr_settlements(
 batch_id uuid NOT NULL REFERENCES masked_xmr_batches(id),
 claim_id uuid NOT NULL REFERENCES masked_claims(id),
 network_genesis text NOT NULL,
 mint varchar(44) NOT NULL,
 bucket text NOT NULL CHECK(bucket IN('creator','community')),
 lamports numeric(78,0) NOT NULL CHECK(lamports>0),
 settled_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(claim_id,mint,bucket),
 FOREIGN KEY(network_genesis,mint) REFERENCES launch_coins(network_genesis,mint)
);
DROP TRIGGER IF EXISTS masked_xmr_settlements_immutable ON masked_xmr_settlements;
CREATE TRIGGER masked_xmr_settlements_immutable BEFORE UPDATE OR DELETE ON masked_xmr_settlements
 FOR EACH ROW EXECUTE FUNCTION rinsed_wallet_immutable();
