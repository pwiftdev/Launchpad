-- wXMR payouts for Masked claims while native XMR payouts are down. The company wallet swaps the
-- claim's SOL for wXMR and sends it to the claiming wallet in one transaction, so either both
-- happen or neither does. A claim above the per-swap limit is paid in several such transactions,
-- one at a time; each one moves its share of the claim's reservations to spent.

ALTER TABLE wallet_jobs DROP CONSTRAINT IF EXISTS wallet_jobs_kind_check;
ALTER TABLE wallet_jobs ADD CONSTRAINT wallet_jobs_kind_check CHECK(kind IN(
 'collect','buyback','creator_claim','community_claim','platform_claim','setup','holder_conversion','wxmr_claim'
));

-- A wXMR payment draws on several coins' reservations at once, so it names no single bucket.
DO $$
DECLARE rule record;
BEGIN
 FOR rule IN SELECT conname FROM pg_constraint
  WHERE conrelid='wallet_jobs'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%bucket IS NULL%'
 LOOP
  EXECUTE format('ALTER TABLE wallet_jobs DROP CONSTRAINT %I', rule.conname);
 END LOOP;
END $$;
ALTER TABLE wallet_jobs ADD CONSTRAINT wallet_jobs_budget CHECK(
 (kind IN('collect','setup') AND bucket IS NULL AND lamports=0)
 OR (kind='wxmr_claim' AND bucket IS NULL AND lamports>0)
 OR (kind NOT IN('collect','setup','wxmr_claim') AND bucket IS NOT NULL AND lamports>0)
);
ALTER TABLE wallet_jobs DROP CONSTRAINT IF EXISTS wallet_wxmr_claim_terms;
ALTER TABLE wallet_jobs ADD CONSTRAINT wallet_wxmr_claim_terms CHECK(
 kind<>'wxmr_claim' OR (recipient IS NOT NULL AND epoch IS NULL AND details ? 'maskedClaim')
);
-- One payment in flight per claim.
CREATE UNIQUE INDEX IF NOT EXISTS wallet_active_wxmr_claim ON wallet_jobs((details->>'maskedClaim'))
 WHERE kind='wxmr_claim' AND status IN('queued','prepared','signed','submitted','manual_review');

-- wXMR claims are paid by wallet jobs, not by an XMR batch.
DO $$
DECLARE rule record;
BEGIN
 FOR rule IN SELECT conname FROM pg_constraint
  WHERE conrelid='masked_claims'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%batch_id IS NOT NULL%'
 LOOP
  EXECUTE format('ALTER TABLE masked_claims DROP CONSTRAINT %I', rule.conname);
 END LOOP;
END $$;
ALTER TABLE masked_claims ADD CONSTRAINT masked_claims_batched
 CHECK(status NOT IN('batched','sent','paid') OR currency IN('sol','wxmr') OR batch_id IS NOT NULL);

-- Each finalized wXMR payment: what it spent and the exact wXMR the wallet received.
CREATE TABLE IF NOT EXISTS masked_wxmr_payments(
 job_id uuid PRIMARY KEY REFERENCES wallet_jobs(id),
 claim_id uuid NOT NULL REFERENCES masked_claims(id),
 network_genesis text NOT NULL,
 recipient varchar(44) NOT NULL,
 signature varchar(88) NOT NULL UNIQUE,
 finalized_slot bigint NOT NULL CHECK(finalized_slot>=0),
 lamports numeric(78,0) NOT NULL CHECK(lamports>0),
 payout_units numeric(39,0) NOT NULL CHECK(payout_units>0),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS masked_wxmr_payments_claim ON masked_wxmr_payments(claim_id);

-- How each payment left the payout ledger: reserved creator or holder SOL became spent.
CREATE TABLE IF NOT EXISTS masked_wxmr_settlements(
 job_id uuid NOT NULL REFERENCES masked_wxmr_payments(job_id),
 claim_id uuid NOT NULL REFERENCES masked_claims(id),
 network_genesis text NOT NULL,
 mint varchar(44) NOT NULL,
 bucket text NOT NULL CHECK(bucket IN('creator','community')),
 lamports numeric(78,0) NOT NULL CHECK(lamports>0),
 PRIMARY KEY(job_id,mint,bucket),
 FOREIGN KEY(network_genesis,mint) REFERENCES launch_coins(network_genesis,mint)
);
CREATE INDEX IF NOT EXISTS masked_wxmr_settlements_claim ON masked_wxmr_settlements(claim_id);

DROP TRIGGER IF EXISTS masked_wxmr_payments_immutable ON masked_wxmr_payments;
CREATE TRIGGER masked_wxmr_payments_immutable BEFORE UPDATE OR DELETE ON masked_wxmr_payments
 FOR EACH ROW EXECUTE FUNCTION rinsed_wallet_immutable();
DROP TRIGGER IF EXISTS masked_wxmr_settlements_immutable ON masked_wxmr_settlements;
CREATE TRIGGER masked_wxmr_settlements_immutable BEFORE UPDATE OR DELETE ON masked_wxmr_settlements
 FOR EACH ROW EXECUTE FUNCTION rinsed_wallet_immutable();
