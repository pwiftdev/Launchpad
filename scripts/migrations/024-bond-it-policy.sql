-- New launches use one policy. Existing coins and their accrued entitlements are not rewritten.
ALTER TABLE launch_configs DROP CONSTRAINT IF EXISTS launch_configs_policy_version_check;
ALTER TABLE launch_configs ADD CONSTRAINT launch_configs_policy_version_check
 CHECK(policy_version IN('rinse-v1','legacy-devnet','wallet-v1','bond-v1'));
ALTER TABLE launch_coins DROP CONSTRAINT IF EXISTS launch_coins_policy_version_check;
ALTER TABLE launch_coins ADD CONSTRAINT launch_coins_policy_version_check
 CHECK(policy_version IN('rinse-v1','legacy-devnet','wallet-v1','bond-v1'));
ALTER TABLE launch_coins DROP CONSTRAINT IF EXISTS launch_coins_mode_check;
ALTER TABLE launch_coins ADD CONSTRAINT launch_coins_mode_check CHECK(mode IN('creator','community','bond'));
ALTER TABLE pending_launch_intents DROP CONSTRAINT IF EXISTS pending_launch_intents_mode_check;
ALTER TABLE pending_launch_intents ADD CONSTRAINT pending_launch_intents_mode_check CHECK(mode IN('creator','community','bond'));
ALTER TABLE launch_coins DROP CONSTRAINT IF EXISTS launch_coins_bond_identity;
ALTER TABLE launch_coins ADD CONSTRAINT launch_coins_bond_identity
 CHECK((policy_version='bond-v1')=(mode='bond'));
ALTER TABLE launch_coins ADD COLUMN IF NOT EXISTS activation_time bigint CHECK(activation_time IS NULL OR activation_time>0);
ALTER TABLE launch_coins DROP CONSTRAINT IF EXISTS launch_coins_bond_time;
ALTER TABLE launch_coins ADD CONSTRAINT launch_coins_bond_time CHECK(policy_version<>'bond-v1' OR activation_time IS NOT NULL);

-- Bind each new intent/coin to the registered configuration's economic version.
CREATE OR REPLACE FUNCTION check_bond_launch_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy text;
BEGIN
 SELECT policy_version INTO policy FROM launch_configs
 WHERE network_genesis=NEW.network_genesis AND config_key=NEW.config_key;
 IF (policy='bond-v1') IS DISTINCT FROM (NEW.mode='bond') THEN
  RAISE EXCEPTION 'Launch mode differs from the registered economic policy';
 END IF;
 IF TG_TABLE_NAME='launch_coins' THEN
  IF NEW.policy_version IS DISTINCT FROM policy THEN
   RAISE EXCEPTION 'Coin policy differs from its registered configuration';
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS launch_intent_bond_policy ON pending_launch_intents;
CREATE TRIGGER launch_intent_bond_policy BEFORE INSERT ON pending_launch_intents
 FOR EACH ROW EXECUTE FUNCTION check_bond_launch_policy();
DROP TRIGGER IF EXISTS launch_coin_bond_policy ON launch_coins;
CREATE TRIGGER launch_coin_bond_policy BEFORE INSERT ON launch_coins
 FOR EACH ROW EXECUTE FUNCTION check_bond_launch_policy();

-- Actual finalized fees/rent are paid only from the platform's earned share.
CREATE TABLE IF NOT EXISTS wallet_operating_costs(
 job_id uuid PRIMARY KEY REFERENCES wallet_jobs(id), signature varchar(88) NOT NULL UNIQUE,
 lamports numeric(78,0) NOT NULL CHECK(lamports>=0)
);
CREATE TABLE IF NOT EXISTS wallet_operating_sources(
 id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES wallet_operating_costs(job_id), network_genesis text NOT NULL,
 mint varchar(44) NOT NULL, lamports numeric(78,0) NOT NULL CHECK(lamports>0),
 FOREIGN KEY(network_genesis,mint) REFERENCES launch_coins(network_genesis,mint)
);
CREATE INDEX IF NOT EXISTS wallet_operating_sources_job ON wallet_operating_sources(job_id);
DROP TRIGGER IF EXISTS wallet_operating_costs_immutable ON wallet_operating_costs;
CREATE TRIGGER wallet_operating_costs_immutable BEFORE UPDATE OR DELETE ON wallet_operating_costs
 FOR EACH ROW EXECUTE FUNCTION rinsed_wallet_immutable();
DROP TRIGGER IF EXISTS wallet_operating_sources_immutable ON wallet_operating_sources;
CREATE TRIGGER wallet_operating_sources_immutable BEFORE UPDATE OR DELETE ON wallet_operating_sources
 FOR EACH ROW EXECUTE FUNCTION rinsed_wallet_immutable();
