-- Finalized executed fees and funded shadow accounting. This schema is not a custody contract.
CREATE TABLE IF NOT EXISTS financial_fee_events (
  network_genesis text NOT NULL,
  mint varchar(44) NOT NULL,
  signature varchar(88) NOT NULL,
  instruction_index integer NOT NULL CHECK(instruction_index >= 0),
  event_index integer NOT NULL CHECK(event_index >= 0),
  finalized_slot bigint NOT NULL CHECK(finalized_slot >= 0),
  trade_time bigint NOT NULL CHECK(trade_time >= 0),
  phase integer NOT NULL CHECK(phase IN (0,1)),
  pool varchar(44) NOT NULL,
  event_digest char(64) NOT NULL,
  total numeric(78,0) NOT NULL CHECK(total >= 0),
  protocol numeric(78,0) NOT NULL CHECK(protocol >= 0),
  referral numeric(78,0) NOT NULL CHECK(referral >= 0),
  rinse_buyback numeric(78,0) NOT NULL CHECK(rinse_buyback >= 0),
  creator numeric(78,0) NOT NULL CHECK(creator >= 0),
  community numeric(78,0) NOT NULL CHECK(community >= 0),
  platform numeric(78,0) NOT NULL CHECK(platform >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(network_genesis,signature,instruction_index,event_index),
  FOREIGN KEY(network_genesis,mint) REFERENCES launch_coins(network_genesis,mint),
  CHECK(total = protocol + referral + rinse_buyback + creator + community + platform)
);
CREATE INDEX IF NOT EXISTS financial_fee_events_coin ON financial_fee_events(network_genesis,mint,finalized_slot);
CREATE TABLE IF NOT EXISTS financial_phase_totals (
  network_genesis text NOT NULL,
  mint varchar(44) NOT NULL,
  phase integer NOT NULL CHECK(phase IN (0,1)),
  observed_net numeric(78,0) NOT NULL DEFAULT 0 CHECK(observed_net >= 0),
  funded_net numeric(78,0) NOT NULL DEFAULT 0 CHECK(funded_net >= 0),
  PRIMARY KEY(network_genesis,mint,phase),
  FOREIGN KEY(network_genesis,mint) REFERENCES launch_coins(network_genesis,mint),
  CHECK(funded_net <= observed_net)
);
CREATE TABLE IF NOT EXISTS financial_collected_reserves (
  network_genesis text NOT NULL,
  mint varchar(44) NOT NULL,
  lamports numeric(78,0) NOT NULL DEFAULT 0 CHECK(lamports >= 0),
  PRIMARY KEY(network_genesis,mint),
  FOREIGN KEY(network_genesis,mint) REFERENCES launch_coins(network_genesis,mint)
);
CREATE TABLE IF NOT EXISTS financial_funding_plans (
  network_genesis text NOT NULL,
  mint varchar(44) NOT NULL,
  commitment char(64) NOT NULL,
  source_kind text NOT NULL CHECK(source_kind IN ('dbc_claim','damm_claim','collected_allocation')),
  status text NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','finalized','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(network_genesis,mint,commitment),
  FOREIGN KEY(network_genesis,mint) REFERENCES launch_coins(network_genesis,mint)
);
CREATE TABLE IF NOT EXISTS financial_planned_fee_events (
  network_genesis text NOT NULL,
  mint varchar(44) NOT NULL,
  signature varchar(88) NOT NULL,
  instruction_index integer NOT NULL,
  event_index integer NOT NULL,
  commitment char(64) NOT NULL,
  PRIMARY KEY(network_genesis,signature,instruction_index,event_index),
  FOREIGN KEY(network_genesis,mint,commitment) REFERENCES financial_funding_plans(network_genesis,mint,commitment),
  FOREIGN KEY(network_genesis,signature,instruction_index,event_index) REFERENCES financial_fee_events(network_genesis,signature,instruction_index,event_index)
);

CREATE TABLE IF NOT EXISTS financial_balances (
  network_genesis text NOT NULL,
  mint varchar(44) NOT NULL,
  bucket text NOT NULL CHECK(bucket IN ('rinse_buyback','creator','community','platform')),
  accrued numeric(78,0) NOT NULL DEFAULT 0 CHECK(accrued >= 0),
  funded numeric(78,0) NOT NULL DEFAULT 0 CHECK(funded >= 0),
  reserved numeric(78,0) NOT NULL DEFAULT 0 CHECK(reserved >= 0),
  spent numeric(78,0) NOT NULL DEFAULT 0 CHECK(spent >= 0),
  PRIMARY KEY(network_genesis,mint,bucket),
  FOREIGN KEY(network_genesis,mint) REFERENCES launch_coins(network_genesis,mint),
  CHECK(funded <= accrued), CHECK(reserved + spent <= funded)
);
CREATE TABLE IF NOT EXISTS financial_funding (
  network_genesis text NOT NULL,
  mint varchar(44) NOT NULL,
  signature varchar(88) NOT NULL,
  instruction_index integer NOT NULL CHECK(instruction_index >= 0),
  vault varchar(44) NOT NULL,
  finalized_slot bigint NOT NULL CHECK(finalized_slot >= 0),
  lamports numeric(78,0) NOT NULL CHECK(lamports > 0),
  source_kind text NOT NULL CHECK(source_kind IN ('dbc_claim','damm_claim','collected_allocation')),
  collected_lamports numeric(78,0) NOT NULL CHECK(collected_lamports >= 0),
  commitment char(64) NOT NULL,
  message_digest char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(network_genesis,signature,instruction_index),
  UNIQUE(network_genesis,mint,commitment),
  FOREIGN KEY(network_genesis,mint) REFERENCES launch_coins(network_genesis,mint)
);
CREATE TABLE IF NOT EXISTS financial_funded_events (
  network_genesis text NOT NULL,
  signature varchar(88) NOT NULL,
  instruction_index integer NOT NULL,
  event_index integer NOT NULL,
  funding_signature varchar(88) NOT NULL,
  funding_instruction_index integer NOT NULL,
  PRIMARY KEY(network_genesis,signature,instruction_index,event_index),
  FOREIGN KEY(network_genesis,signature,instruction_index,event_index)
    REFERENCES financial_fee_events(network_genesis,signature,instruction_index,event_index),
  FOREIGN KEY(network_genesis,funding_signature,funding_instruction_index)
    REFERENCES financial_funding(network_genesis,signature,instruction_index)
);
CREATE TABLE IF NOT EXISTS financial_epochs (
  network_genesis text NOT NULL,
  mint varchar(44) NOT NULL,
  epoch bigint NOT NULL CHECK(epoch >= 0),
  snapshot_slot bigint NOT NULL CHECK(snapshot_slot >= 0),
  snapshot_time bigint NOT NULL CHECK(snapshot_time >= 0),
  snapshot_digest char(64) NOT NULL,
  merkle_root char(64) NOT NULL,
  status text NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','funded')),
  funding_signature varchar(88),
  funding_slot bigint,
  budget numeric(78,0) NOT NULL CHECK(budget >= 0),
  allocated numeric(78,0) NOT NULL CHECK(allocated >= 0),
  carry numeric(78,0) NOT NULL CHECK(carry >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(network_genesis,mint,epoch),
  FOREIGN KEY(network_genesis,mint) REFERENCES launch_coins(network_genesis,mint),
  CHECK(budget = allocated + carry)
);
CREATE TABLE IF NOT EXISTS financial_entitlements (
  network_genesis text NOT NULL,
  mint varchar(44) NOT NULL,
  epoch bigint NOT NULL,
  wallet varchar(44) NOT NULL,
  lamports numeric(78,0) NOT NULL CHECK(lamports > 0),
  proof jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY(network_genesis,mint,epoch,wallet),
  FOREIGN KEY(network_genesis,mint,epoch) REFERENCES financial_epochs(network_genesis,mint,epoch)
);
CREATE TABLE IF NOT EXISTS financial_jobs (
  id uuid PRIMARY KEY,
  network_genesis text NOT NULL,
  mint varchar(44) NOT NULL,
  intent_key text NOT NULL CHECK(length(intent_key) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK(kind IN ('buyback','burn','creator_claim','community_claim','platform_claim')),
  bucket text CHECK(bucket IN ('rinse_buyback','creator','community','platform')),
  lamports numeric(78,0) NOT NULL DEFAULT 0 CHECK(lamports >= 0),
  tokens numeric(78,0) NOT NULL DEFAULT 0 CHECK(tokens >= 0),
  recipient varchar(44),
  epoch bigint,
  parent_job uuid REFERENCES financial_jobs(id),
  status text NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','signed','submitted','finalized','failed','manual_review')),
  message_digest char(64) NOT NULL,
  transaction_base64 text NOT NULL,
  expectations jsonb NOT NULL,
  signature varchar(88) UNIQUE,
  last_valid_block_height bigint NOT NULL CHECK(last_valid_block_height >= 0),
  finalized_slot bigint,
  received_tokens numeric(78,0) NOT NULL DEFAULT 0 CHECK(received_tokens >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(network_genesis,mint,kind,intent_key),
  FOREIGN KEY(network_genesis,mint) REFERENCES launch_coins(network_genesis,mint),
  CHECK((kind = 'burn' AND lamports = 0 AND tokens > 0 AND parent_job IS NOT NULL)
    OR (kind <> 'burn' AND lamports > 0 AND tokens = 0 AND bucket IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS financial_single_burn ON financial_jobs(parent_job) WHERE kind='burn';
CREATE UNIQUE INDEX IF NOT EXISTS financial_single_claim ON financial_jobs(network_genesis,mint,epoch,recipient) WHERE kind='community_claim' AND status <> 'failed';
CREATE UNIQUE INDEX IF NOT EXISTS financial_active_creator_claim ON financial_jobs(network_genesis,mint,recipient)
  WHERE kind='creator_claim' AND status IN ('prepared','signed','submitted','manual_review');
CREATE UNIQUE INDEX IF NOT EXISTS financial_active_buyback ON financial_jobs(network_genesis,mint)
  WHERE kind='buyback' AND status IN ('prepared','signed','submitted','manual_review');
CREATE INDEX IF NOT EXISTS financial_jobs_pending ON financial_jobs(status,updated_at) WHERE status IN ('prepared','signed','submitted','manual_review');
CREATE TABLE IF NOT EXISTS financial_index_cursors (
  network_genesis text NOT NULL,
  pool varchar(44) NOT NULL,
  newest_signature varchar(88),
  oldest_signature varchar(88),
  complete boolean NOT NULL DEFAULT false,
  scan_head_signature varchar(88),
  scan_before_signature varchar(88),
  scan_until_signature varchar(88),
  version bigint NOT NULL DEFAULT 0,
  finalized_slot bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(network_genesis,pool)
);
CREATE TABLE IF NOT EXISTS financial_operator_plans (
  id uuid PRIMARY KEY,
  network_genesis text NOT NULL,
  mint varchar(44) NOT NULL,
  kind text NOT NULL CHECK(kind IN ('setup','funding','epoch')),
  intent_key text NOT NULL,
  transaction_base64 text NOT NULL,
  message_digest char(64) NOT NULL,
  last_valid_block_height bigint NOT NULL,
  metadata jsonb NOT NULL,
  status text NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','signed','submitted','manual_review','finalized','failed')),
  signature varchar(88) UNIQUE,
  finalized_slot bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(network_genesis,kind,intent_key),
  FOREIGN KEY(network_genesis,mint) REFERENCES launch_coins(network_genesis,mint)
);

CREATE OR REPLACE FUNCTION rinsed_financial_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Financial evidence is append-only'; END $$;
DROP TRIGGER IF EXISTS financial_fee_events_immutable ON financial_fee_events;
CREATE TRIGGER financial_fee_events_immutable BEFORE UPDATE OR DELETE ON financial_fee_events FOR EACH ROW EXECUTE FUNCTION rinsed_financial_immutable();
DROP TRIGGER IF EXISTS financial_funding_immutable ON financial_funding;
CREATE TRIGGER financial_funding_immutable BEFORE UPDATE OR DELETE ON financial_funding FOR EACH ROW EXECUTE FUNCTION rinsed_financial_immutable();
CREATE OR REPLACE FUNCTION rinsed_epoch_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status='prepared' AND NEW.status='funded' AND
    (to_jsonb(NEW)-ARRAY['status','funding_signature','funding_slot']) =
    (to_jsonb(OLD)-ARRAY['status','funding_signature','funding_slot']) AND
    NEW.funding_signature IS NOT NULL AND NEW.funding_slot IS NOT NULL THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Financial epoch allocation is immutable';
END $$;
DROP TRIGGER IF EXISTS financial_epochs_immutable ON financial_epochs;
CREATE TRIGGER financial_epochs_immutable BEFORE UPDATE OR DELETE ON financial_epochs FOR EACH ROW EXECUTE FUNCTION rinsed_epoch_immutable();
DROP TRIGGER IF EXISTS financial_entitlements_immutable ON financial_entitlements;
CREATE TRIGGER financial_entitlements_immutable BEFORE UPDATE OR DELETE ON financial_entitlements FOR EACH ROW EXECUTE FUNCTION rinsed_financial_immutable();
