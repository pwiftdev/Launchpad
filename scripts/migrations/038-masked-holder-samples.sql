-- Masked holder rewards follow time-weighted balances. The worker stores one verified, finalized
-- full holder snapshot per five-minute window; the hourly epoch averages that hour's samples.
-- Samples are working evidence: the epoch's snapshot digest commits to them, and old samples
-- are pruned after their epoch is written.
CREATE TABLE IF NOT EXISTS masked_holder_samples(
 network_genesis text NOT NULL,
 mint varchar(44) NOT NULL,
 sample_window bigint NOT NULL CHECK(sample_window>=0),
 slot bigint NOT NULL CHECK(slot>=0),
 block_time bigint NOT NULL CHECK(block_time>=0 AND block_time/300=sample_window),
 digest char(64) NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),
 supply numeric(39,0) NOT NULL CHECK(supply>=0),
 balances jsonb NOT NULL CHECK(jsonb_typeof(balances)='array'),
 excluded jsonb NOT NULL CHECK(jsonb_typeof(excluded)='array'),
 PRIMARY KEY(network_genesis,mint,sample_window),
 FOREIGN KEY(network_genesis,mint) REFERENCES launch_coins(network_genesis,mint)
);
CREATE OR REPLACE FUNCTION masked_sample_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Holder samples are append-only'; END $$;
DROP TRIGGER IF EXISTS masked_holder_samples_immutable ON masked_holder_samples;
CREATE TRIGGER masked_holder_samples_immutable BEFORE UPDATE ON masked_holder_samples
 FOR EACH ROW EXECUTE FUNCTION masked_sample_immutable();

-- How many samples an epoch averaged, for audits and the proof page.
ALTER TABLE wallet_epochs ADD COLUMN IF NOT EXISTS sample_count smallint CHECK(sample_count IS NULL OR sample_count>0);
