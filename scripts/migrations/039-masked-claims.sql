-- One claim screen for Masked creators and holders. A claim takes everything the wallet has
-- earned across Masked coins and pays it in native XMR, in wXMR when native payouts are down,
-- or in SOL. SOL claims run as ordinary payout jobs per coin; XMR and wXMR claims wait for the
-- daily batch. The Monero address is kept encrypted only until the payout settles.
CREATE TABLE IF NOT EXISTS masked_claims(
 id uuid PRIMARY KEY,
 network_genesis text NOT NULL,
 wallet varchar(44) NOT NULL,
 currency text NOT NULL CHECK(currency IN('xmr','wxmr','sol')),
 lamports numeric(78,0) NOT NULL CHECK(lamports>0),
 request_id uuid NOT NULL,
 authorization_digest char(64) NOT NULL CHECK(authorization_digest~'^[a-f0-9]{64}$'),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','batched','sent','paid','failed')),
 address_sealed bytea,
 batch_id uuid,
 xmr_atomic numeric(39,0) CHECK(xmr_atomic IS NULL OR xmr_atomic>0),
 sol_jobs uuid[] NOT NULL DEFAULT '{}',
 failure text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(network_genesis,request_id),
 -- XMR needs an address until it settles; SOL and wXMR pay the signing wallet.
 CHECK(currency<>'xmr' OR status IN('paid','failed') OR address_sealed IS NOT NULL),
 CHECK(currency='xmr' OR address_sealed IS NULL),
 CHECK(currency<>'sol' OR status IN('sent','paid','failed')),
 CHECK(status NOT IN('batched','sent','paid') OR currency='sol' OR batch_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS masked_claims_wallet ON masked_claims(network_genesis,wallet,created_at DESC);
CREATE INDEX IF NOT EXISTS masked_claims_queue ON masked_claims(network_genesis,currency,status,created_at);
-- One open claim per wallet at a time keeps reservations simple and auditable.
CREATE UNIQUE INDEX IF NOT EXISTS masked_claims_one_open ON masked_claims(network_genesis,wallet)
 WHERE status IN('queued','batched','sent');

-- What a claim takes: a creator amount per coin, or one holder allocation per coin and hour.
CREATE TABLE IF NOT EXISTS masked_claim_items(
 claim_id uuid NOT NULL REFERENCES masked_claims(id),
 network_genesis text NOT NULL,
 mint varchar(44) NOT NULL,
 kind text NOT NULL CHECK(kind IN('creator','holder')),
 epoch bigint,
 wallet varchar(44) NOT NULL,
 lamports numeric(78,0) NOT NULL CHECK(lamports>0),
 CHECK((kind='holder')=(epoch IS NOT NULL)),
 FOREIGN KEY(network_genesis,mint) REFERENCES launch_coins(network_genesis,mint),
 FOREIGN KEY(network_genesis,mint,epoch,wallet) REFERENCES wallet_allocations(network_genesis,mint,epoch,wallet)
);
CREATE UNIQUE INDEX IF NOT EXISTS masked_claim_items_holder
 ON masked_claim_items(network_genesis,mint,epoch,wallet) WHERE kind='holder';
CREATE INDEX IF NOT EXISTS masked_claim_items_claim ON masked_claim_items(claim_id);

-- A claim row only moves forward, and its money fields never change once written.
CREATE OR REPLACE FUNCTION masked_claim_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Masked claims are permanent'; END IF;
 IF (NEW.id,NEW.network_genesis,NEW.wallet,NEW.currency,NEW.lamports,NEW.request_id,NEW.authorization_digest,NEW.created_at)
    IS DISTINCT FROM
    (OLD.id,OLD.network_genesis,OLD.wallet,OLD.currency,OLD.lamports,OLD.request_id,OLD.authorization_digest,OLD.created_at)
 THEN RAISE EXCEPTION 'Masked claim terms are immutable'; END IF;
 IF OLD.status IN('paid','failed') AND NEW.status IS DISTINCT FROM OLD.status THEN
  RAISE EXCEPTION 'A settled Masked claim cannot change';
 END IF;
 IF OLD.xmr_atomic IS NOT NULL AND NEW.xmr_atomic IS DISTINCT FROM OLD.xmr_atomic THEN
  RAISE EXCEPTION 'A priced Masked claim keeps its XMR amount';
 END IF;
 IF NEW.address_sealed IS NOT NULL AND NEW.address_sealed IS DISTINCT FROM OLD.address_sealed THEN
  RAISE EXCEPTION 'A Monero address can only be erased';
 END IF;
 NEW.updated_at=now();
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS masked_claims_transition ON masked_claims;
CREATE TRIGGER masked_claims_transition BEFORE UPDATE OR DELETE ON masked_claims
 FOR EACH ROW EXECUTE FUNCTION masked_claim_transition();

-- A Masked creator who also holds their coin may have a creator payout and a holder payout open
-- at once: they draw on different reservations. One open payout per kind still applies.
DROP INDEX IF EXISTS wallet_active_claim;
CREATE UNIQUE INDEX wallet_active_claim ON wallet_jobs(network_genesis,mint,recipient,kind)
 WHERE kind IN('creator_claim','community_claim') AND status IN('queued','prepared','signed','submitted','manual_review');

-- The operator writes how its Monero wallet is doing; the claim screen offers wXMR instead of
-- XMR while native payouts are down. Display and routing only: payouts re-check the wallet.
CREATE TABLE IF NOT EXISTS masked_payout_status(
 network_genesis text PRIMARY KEY,
 monero_ok boolean NOT NULL,
 unlocked_atomic numeric(39,0) NOT NULL DEFAULT 0 CHECK(unlocked_atomic>=0),
 wallet_height bigint,
 detail text,
 heartbeat_at timestamptz NOT NULL DEFAULT now()
);
