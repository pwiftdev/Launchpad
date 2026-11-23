-- Older releases only supported native SOL. The defaults preserve those immutable identities.
ALTER TABLE launch_configs ADD COLUMN IF NOT EXISTS quote_mint varchar(44) NOT NULL DEFAULT 'So11111111111111111111111111111111111111112';
ALTER TABLE launch_coins ADD COLUMN IF NOT EXISTS quote_mint varchar(44) NOT NULL DEFAULT 'So11111111111111111111111111111111111111112';
ALTER TABLE launch_configs DROP CONSTRAINT IF EXISTS launch_configs_policy_version_check;
ALTER TABLE launch_configs ADD CONSTRAINT launch_configs_policy_version_check
 CHECK(policy_version IN ('rinse-v1','legacy-devnet','wallet-v1','bond-v1','mskd-v1','dev-v1','cashback-v1'));
ALTER TABLE launch_configs DROP CONSTRAINT IF EXISTS launch_config_quote_policy;
ALTER TABLE launch_configs ADD CONSTRAINT launch_config_quote_policy CHECK(
 quote_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
 AND (policy_version='mskd-v1')=(quote_mint<>'So11111111111111111111111111111111111111112')
 AND (policy_version<>'mskd-v1' OR network_genesis<>'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
      OR quote_mint='he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A'));
ALTER TABLE launch_coins DROP CONSTRAINT IF EXISTS launch_coins_policy_version_check;
ALTER TABLE launch_coins ADD CONSTRAINT launch_coins_policy_version_check
 CHECK(policy_version IN ('rinse-v1','legacy-devnet','wallet-v1','bond-v1','mskd-v1','dev-v1','cashback-v1'));
ALTER TABLE launch_coins DROP CONSTRAINT IF EXISTS launch_coins_mode_check;
ALTER TABLE launch_coins ADD CONSTRAINT launch_coins_mode_check CHECK(mode IN ('creator','community','bond','mskd','dev','cashback'));
ALTER TABLE pending_launch_intents DROP CONSTRAINT IF EXISTS pending_launch_intents_mode_check;
ALTER TABLE pending_launch_intents ADD CONSTRAINT pending_launch_intents_mode_check CHECK(mode IN ('creator','community','bond','mskd','dev','cashback'));
ALTER TABLE launch_coins DROP CONSTRAINT IF EXISTS launch_coins_bond_time;
ALTER TABLE launch_coins ADD CONSTRAINT launch_coins_bond_time CHECK(policy_version NOT IN ('bond-v1','mskd-v1','dev-v1','cashback-v1') OR activation_time IS NOT NULL);

CREATE OR REPLACE FUNCTION check_bond_launch_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cfg launch_configs%ROWTYPE;
BEGIN
 SELECT * INTO STRICT cfg FROM launch_configs
 WHERE network_genesis=NEW.network_genesis AND config_key=NEW.config_key;
 IF NEW.mode IN ('creator','community') THEN
  IF cfg.policy_version NOT IN ('wallet-v1','rinse-v1','legacy-devnet') THEN
   RAISE EXCEPTION 'Historical mode requires a historical configuration';
  END IF;
 ELSIF cfg.policy_version IS DISTINCT FROM NEW.mode || '-v1' THEN
  RAISE EXCEPTION 'Launch mode differs from the registered economic policy';
 END IF;
 IF TG_TABLE_NAME='launch_coins' THEN
  IF (NEW.policy_version,NEW.quote_mint) IS DISTINCT FROM (cfg.policy_version,cfg.quote_mint) THEN
   RAISE EXCEPTION 'Coin policy or quote mint differs from its registered configuration';
  END IF;
 END IF;
 RETURN NEW;
END $$;

-- Record applied revisions so later releases cannot replay superseded constraints over live rows.
CREATE TABLE IF NOT EXISTS launch_schema_migrations (
 filename text PRIMARY KEY,
 sha256 char(64) NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$')
);

-- Network fees and rent always use SOL, even for hSOL-denominated collections and claims.
CREATE TABLE IF NOT EXISTS wallet_mode_sol_expenses (
 job_id uuid PRIMARY KEY REFERENCES wallet_jobs(id),
 signature varchar(88) NOT NULL UNIQUE,
 lamports numeric(78,0) NOT NULL CHECK(lamports>=0)
);
DROP TRIGGER IF EXISTS wallet_mode_sol_expenses_immutable ON wallet_mode_sol_expenses;
CREATE TRIGGER wallet_mode_sol_expenses_immutable BEFORE UPDATE OR DELETE ON wallet_mode_sol_expenses
 FOR EACH ROW EXECUTE FUNCTION rinsed_wallet_immutable();
