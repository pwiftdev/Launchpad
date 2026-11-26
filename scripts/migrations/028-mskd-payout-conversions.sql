ALTER TABLE wallet_jobs DROP CONSTRAINT wallet_jobs_kind_check;
ALTER TABLE wallet_jobs ADD CONSTRAINT wallet_jobs_kind_check CHECK(kind IN(
 'collect','buyback','creator_claim','community_claim','platform_claim','setup','holder_conversion'
));
ALTER TABLE wallet_jobs ADD CONSTRAINT wallet_conversion_budget
 CHECK(kind<>'holder_conversion' OR bucket IS NOT DISTINCT FROM 'community');
CREATE UNIQUE INDEX wallet_active_conversion ON wallet_jobs(network_genesis,mint)
 WHERE kind='holder_conversion' AND status IN('queued','prepared','signed','submitted','manual_review');
CREATE INDEX wallet_finalized_token_claims ON wallet_jobs(network_genesis,(details->>'collector'),(details->>'assetMint'))
 WHERE kind='community_claim' AND status='finalized' AND details ? 'assetMint';

ALTER TABLE wallet_epochs ADD COLUMN asset_mint varchar(44) NOT NULL DEFAULT 'So11111111111111111111111111111111111111112';
ALTER TABLE wallet_epochs ADD COLUMN source_carry_lamports numeric(78,0) NOT NULL DEFAULT 0 CHECK(source_carry_lamports>=0);
ALTER TABLE wallet_allocations ADD COLUMN source_lamports numeric(78,0) CHECK(source_lamports>=0);

CREATE TABLE wallet_mskd_snapshots (
 job_id uuid PRIMARY KEY REFERENCES wallet_jobs(id),
 network_genesis text NOT NULL,
 mint varchar(44) NOT NULL,
 epoch bigint NOT NULL CHECK(epoch>=0),
 snapshot_slot bigint NOT NULL CHECK(snapshot_slot>=0),
 snapshot_time bigint NOT NULL CHECK(snapshot_time/3600-1=epoch AND snapshot_time%3600<60),
 snapshot_digest char(64) NOT NULL CHECK(snapshot_digest~'^[a-f0-9]{64}$'),
 payout_mint varchar(44) NOT NULL CHECK(payout_mint<>'So11111111111111111111111111111111111111112'),
 excluded_owners jsonb NOT NULL CHECK(jsonb_typeof(excluded_owners)='array'),
 owner_weights jsonb NOT NULL CHECK(jsonb_typeof(owner_weights)='array'),
 UNIQUE(network_genesis,mint,epoch),
 FOREIGN KEY(network_genesis,mint) REFERENCES launch_coins(network_genesis,mint)
);
CREATE TABLE wallet_mskd_conversions (
 job_id uuid PRIMARY KEY REFERENCES wallet_mskd_snapshots(job_id),
 signature varchar(88) NOT NULL UNIQUE,
 finalized_slot bigint NOT NULL CHECK(finalized_slot>=0),
 spent_lamports numeric(78,0) NOT NULL CHECK(spent_lamports>0),
 received_units numeric(78,0) NOT NULL CHECK(received_units>0)
);
CREATE TRIGGER wallet_mskd_snapshots_immutable BEFORE UPDATE OR DELETE ON wallet_mskd_snapshots
 FOR EACH ROW EXECUTE FUNCTION rinsed_wallet_immutable();
CREATE TRIGGER wallet_mskd_conversions_immutable BEFORE UPDATE OR DELETE ON wallet_mskd_conversions
 FOR EACH ROW EXECUTE FUNCTION rinsed_wallet_immutable();
