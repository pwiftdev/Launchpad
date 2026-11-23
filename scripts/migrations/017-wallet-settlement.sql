-- Separate wallet-controlled settlement. Existing native-vault facts and balances stay untouched.
ALTER TABLE launch_configs DROP CONSTRAINT IF EXISTS launch_configs_policy_version_check;
ALTER TABLE launch_configs ADD CONSTRAINT launch_configs_policy_version_check CHECK(policy_version IN('rinse-v1','legacy-devnet','wallet-v1','bond-v1'));
ALTER TABLE launch_coins DROP CONSTRAINT IF EXISTS launch_coins_policy_version_check;
ALTER TABLE launch_coins ADD CONSTRAINT launch_coins_policy_version_check CHECK(policy_version IN('rinse-v1','legacy-devnet','wallet-v1','bond-v1'));

CREATE TABLE IF NOT EXISTS wallet_balances(
 network_genesis text NOT NULL,mint varchar(44) NOT NULL,bucket text NOT NULL CHECK(bucket IN('rinse_buyback','creator','community','platform')),
 funded numeric(78,0) NOT NULL DEFAULT 0,reserved numeric(78,0) NOT NULL DEFAULT 0,spent numeric(78,0) NOT NULL DEFAULT 0,
 PRIMARY KEY(network_genesis,mint,bucket),FOREIGN KEY(network_genesis,mint) REFERENCES launch_coins(network_genesis,mint),
 CHECK(funded>=0 AND reserved>=0 AND spent>=0 AND funded>=reserved+spent)
);
CREATE TABLE IF NOT EXISTS wallet_phase_totals(
 network_genesis text NOT NULL,mint varchar(44) NOT NULL,rinse_net numeric(78,0) NOT NULL DEFAULT 0 CHECK(rinse_net>=0),
 post_net numeric(78,0) NOT NULL DEFAULT 0 CHECK(post_net>=0),PRIMARY KEY(network_genesis,mint),
 FOREIGN KEY(network_genesis,mint) REFERENCES launch_coins(network_genesis,mint)
);
CREATE TABLE IF NOT EXISTS wallet_fee_events(
 network_genesis text NOT NULL,mint varchar(44) NOT NULL,pool varchar(44) NOT NULL,signature varchar(88) NOT NULL,
 instruction_index integer NOT NULL CHECK(instruction_index>=0),event_index integer NOT NULL CHECK(event_index>=0),
 finalized_slot bigint NOT NULL CHECK(finalized_slot>=0),trade_time bigint NOT NULL CHECK(trade_time>=0),phase smallint NOT NULL CHECK(phase IN(0,1)),
 total numeric(78,0) NOT NULL CHECK(total>=0),protocol numeric(78,0) NOT NULL CHECK(protocol>=0),referral numeric(78,0) NOT NULL CHECK(referral>=0),
 net numeric(78,0) NOT NULL CHECK(net>=0),event_digest char(64) NOT NULL CHECK(event_digest~'^[a-f0-9]{64}$'),
 PRIMARY KEY(network_genesis,signature,instruction_index,event_index),FOREIGN KEY(network_genesis,mint) REFERENCES launch_coins(network_genesis,mint),
 CHECK(total=protocol+referral+net)
);
CREATE INDEX IF NOT EXISTS wallet_fee_events_pool ON wallet_fee_events(network_genesis,mint,pool,finalized_slot,signature);
CREATE TABLE IF NOT EXISTS wallet_index_cursors(
 network_genesis text NOT NULL,pool varchar(44) NOT NULL,newest_signature varchar(88),oldest_signature varchar(88),complete boolean NOT NULL DEFAULT false,
 scan_head_signature varchar(88),scan_before_signature varchar(88),scan_until_signature varchar(88),version bigint NOT NULL DEFAULT 0,
 finalized_slot bigint NOT NULL DEFAULT 0,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(network_genesis,pool)
);
CREATE TABLE IF NOT EXISTS wallet_jobs(
 id uuid PRIMARY KEY,network_genesis text NOT NULL,mint varchar(44) NOT NULL,
 kind text NOT NULL CHECK(kind IN('collect','buyback','creator_claim','community_claim','platform_claim','setup')),
 intent_key text NOT NULL CHECK(length(intent_key) BETWEEN 1 AND 200),bucket text CHECK(bucket IN('rinse_buyback','creator','community','platform')),
 recipient varchar(44),epoch bigint CHECK(epoch>=0),lamports numeric(78,0) NOT NULL DEFAULT 0 CHECK(lamports>=0),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','prepared','signed','submitted','manual_review','finalized','failed')),
 transaction_base64 text,message_digest char(64),prepared_slot bigint,last_valid_block_height bigint,signature varchar(88) UNIQUE,
 finalized_slot bigint,received_lamports numeric(78,0) NOT NULL DEFAULT 0 CHECK(received_lamports>=0),burned_tokens numeric(78,0) NOT NULL DEFAULT 0 CHECK(burned_tokens>=0),
 expectations jsonb NOT NULL DEFAULT '{}',details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(network_genesis,mint,kind,intent_key),FOREIGN KEY(network_genesis,mint) REFERENCES launch_coins(network_genesis,mint),
 CHECK((kind IN('collect','setup') AND bucket IS NULL AND lamports=0) OR(kind NOT IN('collect','setup') AND bucket IS NOT NULL AND lamports>0)),
 CHECK((transaction_base64 IS NULL AND message_digest IS NULL AND prepared_slot IS NULL AND last_valid_block_height IS NULL) OR
 (transaction_base64 IS NOT NULL AND message_digest IS NOT NULL AND message_digest~'^[a-f0-9]{64}$' AND prepared_slot IS NOT NULL AND prepared_slot>=0 AND last_valid_block_height IS NOT NULL AND last_valid_block_height>=0)),
 CHECK(signature IS NULL OR transaction_base64 IS NOT NULL),
 CHECK(status IN('queued','failed') OR transaction_base64 IS NOT NULL),
 CHECK(status NOT IN('signed','submitted','manual_review') OR signature IS NOT NULL),
 CHECK(kind NOT IN('creator_claim','community_claim','platform_claim') OR recipient IS NOT NULL),
 CHECK((kind='community_claim')=(epoch IS NOT NULL)),
 CHECK(status<>'finalized' OR(signature IS NOT NULL AND finalized_slot IS NOT NULL AND message_digest IS NOT NULL)),
 CHECK(status<>'finalized' OR kind<>'collect' OR received_lamports>0),
 CHECK(status<>'finalized' OR kind<>'buyback' OR burned_tokens>0)
);
CREATE UNIQUE INDEX IF NOT EXISTS wallet_active_collection ON wallet_jobs(network_genesis,mint) WHERE kind='collect' AND status IN('queued','prepared','signed','submitted','manual_review');
CREATE UNIQUE INDEX IF NOT EXISTS wallet_active_buyback ON wallet_jobs(network_genesis,mint) WHERE kind='buyback' AND status IN('queued','prepared','signed','submitted','manual_review');
CREATE UNIQUE INDEX IF NOT EXISTS wallet_active_setup ON wallet_jobs(network_genesis,mint) WHERE kind='setup' AND status IN('queued','prepared','signed','submitted','manual_review');
CREATE UNIQUE INDEX IF NOT EXISTS wallet_active_platform ON wallet_jobs(network_genesis,mint) WHERE kind='platform_claim' AND status IN('queued','prepared','signed','submitted','manual_review');
CREATE UNIQUE INDEX IF NOT EXISTS wallet_active_claim ON wallet_jobs(network_genesis,mint,recipient) WHERE kind IN('creator_claim','community_claim') AND status IN('queued','prepared','signed','submitted','manual_review');
CREATE UNIQUE INDEX IF NOT EXISTS wallet_epoch_once ON wallet_jobs(network_genesis,mint,recipient,epoch) WHERE kind='community_claim' AND status<>'failed';
CREATE INDEX IF NOT EXISTS wallet_jobs_pending ON wallet_jobs(network_genesis,status,created_at,id);
CREATE TABLE IF NOT EXISTS wallet_fee_reservations(
 network_genesis text NOT NULL,signature varchar(88) NOT NULL,instruction_index integer NOT NULL,event_index integer NOT NULL,job_id uuid NOT NULL REFERENCES wallet_jobs(id),
 PRIMARY KEY(network_genesis,signature,instruction_index,event_index),
 FOREIGN KEY(network_genesis,signature,instruction_index,event_index) REFERENCES wallet_fee_events(network_genesis,signature,instruction_index,event_index)
);
CREATE TABLE IF NOT EXISTS wallet_collected_events(
 network_genesis text NOT NULL,signature varchar(88) NOT NULL,instruction_index integer NOT NULL,event_index integer NOT NULL,job_id uuid NOT NULL REFERENCES wallet_jobs(id),
 PRIMARY KEY(network_genesis,signature,instruction_index,event_index),
 FOREIGN KEY(network_genesis,signature,instruction_index,event_index) REFERENCES wallet_fee_events(network_genesis,signature,instruction_index,event_index)
);
CREATE TABLE IF NOT EXISTS wallet_collections(
 job_id uuid PRIMARY KEY REFERENCES wallet_jobs(id),network_genesis text NOT NULL,mint varchar(44) NOT NULL,pool varchar(44) NOT NULL,
 signature varchar(88) NOT NULL UNIQUE,finalized_slot bigint NOT NULL,transaction_index integer NOT NULL CHECK(transaction_index>=0),
 received numeric(78,0) NOT NULL CHECK(received>0),raw_observed numeric(78,0) NOT NULL CHECK(raw_observed>=received),
 rinse_net numeric(78,0) NOT NULL CHECK(rinse_net>=0),post_net numeric(78,0) NOT NULL CHECK(post_net>=0),
 rinse_buyback numeric(78,0) NOT NULL CHECK(rinse_buyback>=0),creator numeric(78,0) NOT NULL CHECK(creator>=0),
 community numeric(78,0) NOT NULL CHECK(community>=0),platform numeric(78,0) NOT NULL CHECK(platform>=0),
 CHECK(received=rinse_net+post_net AND received=rinse_buyback+creator+community+platform),
 FOREIGN KEY(network_genesis,mint) REFERENCES launch_coins(network_genesis,mint)
);
CREATE TABLE IF NOT EXISTS wallet_collection_cursors(
 network_genesis text NOT NULL,mint varchar(44) NOT NULL,pool varchar(44) NOT NULL,job_id uuid NOT NULL REFERENCES wallet_jobs(id),
 finalized_slot bigint NOT NULL CHECK(finalized_slot>=0),transaction_index integer NOT NULL CHECK(transaction_index>=0),slot_signatures jsonb NOT NULL CHECK(jsonb_typeof(slot_signatures)='array' AND jsonb_array_length(slot_signatures)=transaction_index+1),
 PRIMARY KEY(network_genesis,pool),FOREIGN KEY(network_genesis,mint) REFERENCES launch_coins(network_genesis,mint)
);
CREATE TABLE IF NOT EXISTS wallet_epochs(
 network_genesis text NOT NULL,mint varchar(44) NOT NULL,epoch bigint NOT NULL CHECK(epoch>=0),snapshot_slot bigint NOT NULL CHECK(snapshot_slot>=0),snapshot_time bigint NOT NULL CHECK(snapshot_time>=0 AND snapshot_time/3600-1=epoch AND snapshot_time%3600<60),
 snapshot_digest char(64) NOT NULL CHECK(snapshot_digest~'^[a-f0-9]{64}$'),budget numeric(78,0) NOT NULL CHECK(budget>=0),allocated numeric(78,0) NOT NULL CHECK(allocated>=0),
 carry numeric(78,0) NOT NULL CHECK(carry>=0),PRIMARY KEY(network_genesis,mint,epoch),CHECK(budget=allocated+carry),
 FOREIGN KEY(network_genesis,mint) REFERENCES launch_coins(network_genesis,mint)
);
CREATE TABLE IF NOT EXISTS wallet_allocations(
 network_genesis text NOT NULL,mint varchar(44) NOT NULL,epoch bigint NOT NULL,wallet varchar(44) NOT NULL,lamports numeric(78,0) NOT NULL CHECK(lamports>0),
 PRIMARY KEY(network_genesis,mint,epoch,wallet),FOREIGN KEY(network_genesis,mint,epoch) REFERENCES wallet_epochs(network_genesis,mint,epoch)
);
CREATE TABLE IF NOT EXISTS wallet_claim_requests(
 network_genesis text NOT NULL,request_id uuid NOT NULL,mint varchar(44) NOT NULL,wallet varchar(44) NOT NULL,epoch bigint,
 lamports numeric(78,0) NOT NULL CHECK(lamports>0),authorization_digest char(64) NOT NULL CHECK(authorization_digest~'^[a-f0-9]{64}$'),job_id uuid NOT NULL REFERENCES wallet_jobs(id),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(network_genesis,request_id)
);
CREATE TABLE IF NOT EXISTS wallet_job_attempts(
 job_id uuid NOT NULL REFERENCES wallet_jobs(id),message_digest char(64) NOT NULL,transaction_base64 text NOT NULL,signature varchar(88),
 prepared_slot bigint NOT NULL,last_valid_block_height bigint NOT NULL,finalized_expiry_height bigint NOT NULL,proof_slot bigint NOT NULL,proof jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(job_id,message_digest)
);
CREATE TABLE IF NOT EXISTS wallet_scheduler_state(
 network_genesis text NOT NULL,collector varchar(44) NOT NULL,cursor_mint varchar(44),last_started_at timestamptz,last_completed_at timestamptz,last_progress_at timestamptz,
 last_status text NOT NULL CHECK(last_status IN('running','completed','stopped','failed')),last_processed integer NOT NULL DEFAULT 0 CHECK(last_processed>=0),
 last_failed integer NOT NULL DEFAULT 0 CHECK(last_failed>=0),PRIMARY KEY(network_genesis,collector)
);
CREATE OR REPLACE FUNCTION rinsed_wallet_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Wallet financial facts are append-only'; END $$;
DROP TRIGGER IF EXISTS wallet_fee_events_immutable ON wallet_fee_events;
CREATE TRIGGER wallet_fee_events_immutable BEFORE UPDATE OR DELETE ON wallet_fee_events FOR EACH ROW EXECUTE FUNCTION rinsed_wallet_immutable();
DROP TRIGGER IF EXISTS wallet_collections_immutable ON wallet_collections;
CREATE TRIGGER wallet_collections_immutable BEFORE UPDATE OR DELETE ON wallet_collections FOR EACH ROW EXECUTE FUNCTION rinsed_wallet_immutable();
DROP TRIGGER IF EXISTS wallet_collected_events_immutable ON wallet_collected_events;
CREATE TRIGGER wallet_collected_events_immutable BEFORE UPDATE OR DELETE ON wallet_collected_events FOR EACH ROW EXECUTE FUNCTION rinsed_wallet_immutable();
DROP TRIGGER IF EXISTS wallet_epochs_immutable ON wallet_epochs;
CREATE TRIGGER wallet_epochs_immutable BEFORE UPDATE OR DELETE ON wallet_epochs FOR EACH ROW EXECUTE FUNCTION rinsed_wallet_immutable();
DROP TRIGGER IF EXISTS wallet_allocations_immutable ON wallet_allocations;
CREATE TRIGGER wallet_allocations_immutable BEFORE UPDATE OR DELETE ON wallet_allocations FOR EACH ROW EXECUTE FUNCTION rinsed_wallet_immutable();
DROP TRIGGER IF EXISTS wallet_claim_requests_immutable ON wallet_claim_requests;
CREATE TRIGGER wallet_claim_requests_immutable BEFORE UPDATE OR DELETE ON wallet_claim_requests FOR EACH ROW EXECUTE FUNCTION rinsed_wallet_immutable();
DROP TRIGGER IF EXISTS wallet_attempts_immutable ON wallet_job_attempts;
CREATE TRIGGER wallet_attempts_immutable BEFORE UPDATE OR DELETE ON wallet_job_attempts FOR EACH ROW EXECUTE FUNCTION rinsed_wallet_immutable();
CREATE OR REPLACE FUNCTION rinsed_wallet_job_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (NEW.id,NEW.network_genesis,NEW.mint,NEW.kind,NEW.intent_key,NEW.bucket,NEW.recipient,NEW.epoch,NEW.lamports,NEW.details)
 IS DISTINCT FROM(OLD.id,OLD.network_genesis,OLD.mint,OLD.kind,OLD.intent_key,OLD.bucket,OLD.recipient,OLD.epoch,OLD.lamports,OLD.details)
 THEN RAISE EXCEPTION 'Wallet job identity and entitlement are immutable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS wallet_job_identity_immutable ON wallet_jobs;
CREATE TRIGGER wallet_job_identity_immutable BEFORE UPDATE OR DELETE ON wallet_jobs FOR EACH ROW EXECUTE FUNCTION rinsed_wallet_job_identity();
