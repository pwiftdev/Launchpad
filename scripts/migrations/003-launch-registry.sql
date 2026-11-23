-- One economic identity per chain/mint. A creator transfer or mutable metadata cannot reassign it.
CREATE TABLE IF NOT EXISTS launch_configs (
  network_genesis varchar(64) NOT NULL,
  config_key varchar(44) NOT NULL,
  policy_version text NOT NULL CHECK (policy_version IN ('rinse-v1','legacy-devnet')),
  expected_fee_claimer varchar(44) NOT NULL,
  expected_leftover_receiver varchar(44) NOT NULL,
  config_digest char(64) NOT NULL CHECK (config_digest ~ '^[a-f0-9]{64}$'),
  enabled_for_launch boolean NOT NULL DEFAULT false,
  verified_slot bigint NOT NULL CHECK (verified_slot >= 0),
  verified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(network_genesis,config_key)
);
CREATE TABLE IF NOT EXISTS pending_launch_intents (
  network_genesis varchar(64) NOT NULL,
  mint varchar(44) NOT NULL,
  config_key varchar(44) NOT NULL,
  deployer varchar(44) NOT NULL,
  mode text NOT NULL CHECK (mode IN ('creator','community')),
  payload_digest char(64) NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  prepared_slot bigint NOT NULL DEFAULT 0 CHECK (prepared_slot >= 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(network_genesis,mint),
  FOREIGN KEY(network_genesis,config_key) REFERENCES launch_configs(network_genesis,config_key)
);
-- Existing local rehearsals may already have the table. Zero identifies pre-slot legacy intents.
ALTER TABLE pending_launch_intents ADD COLUMN IF NOT EXISTS prepared_slot bigint NOT NULL DEFAULT 0 CHECK (prepared_slot >= 0);
CREATE TABLE IF NOT EXISTS launch_coins (
  network_genesis varchar(64) NOT NULL,
  mint varchar(44) NOT NULL,
  dbc_pool varchar(44) NOT NULL,
  config_key varchar(44) NOT NULL,
  original_deployer varchar(44) NOT NULL,
  mode text NOT NULL CHECK (mode IN ('creator','community')),
  recipient varchar(44) NOT NULL,
  policy_version text NOT NULL CHECK (policy_version IN ('rinse-v1','legacy-devnet')),
  activation_point bigint NOT NULL CHECK (activation_point >= 0),
  creation_signature varchar(88) NOT NULL,
  finalized_slot bigint NOT NULL CHECK (finalized_slot >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(network_genesis,mint),
  UNIQUE(network_genesis,dbc_pool),
  UNIQUE(network_genesis,creation_signature,mint),
  FOREIGN KEY(network_genesis,config_key) REFERENCES launch_configs(network_genesis,config_key),
  CHECK (mode = 'community' OR recipient = original_deployer)
);
CREATE INDEX IF NOT EXISTS launch_coins_config ON launch_coins(network_genesis,config_key);
CREATE TABLE IF NOT EXISTS launch_migrations (
  network_genesis varchar(64) NOT NULL,
  mint varchar(44) NOT NULL,
  damm_pool varchar(44) NOT NULL,
  migration_activation_point bigint NOT NULL CHECK (migration_activation_point>=0),
  finalized_slot bigint NOT NULL CHECK (finalized_slot>=0),
  account_digest char(64) NOT NULL CHECK (account_digest ~ '^[a-f0-9]{64}$'),
  registered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(network_genesis,mint),
  UNIQUE(network_genesis,damm_pool),
  FOREIGN KEY(network_genesis,mint) REFERENCES launch_coins(network_genesis,mint)
);
CREATE TABLE IF NOT EXISTS launch_migration_proofs (
  network_genesis varchar(64) NOT NULL,
  mint varchar(44) NOT NULL,
  creation_signature varchar(88) NOT NULL,
  creation_slot bigint NOT NULL CHECK(creation_slot>=0),
  verified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(network_genesis,mint),
  FOREIGN KEY(network_genesis,mint) REFERENCES launch_migrations(network_genesis,mint)
);
CREATE OR REPLACE FUNCTION rinsed_reject_registry_reassignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'launch_configs' THEN
    IF (to_jsonb(NEW) - 'enabled_for_launch') IS DISTINCT FROM (to_jsonb(OLD) - 'enabled_for_launch') THEN
      RAISE EXCEPTION 'Reviewed launch configuration is immutable';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Launch economic identity is immutable';
END $$;
DROP TRIGGER IF EXISTS launch_config_immutable ON launch_configs;
CREATE TRIGGER launch_config_immutable BEFORE UPDATE ON launch_configs FOR EACH ROW EXECUTE FUNCTION rinsed_reject_registry_reassignment();
DROP TRIGGER IF EXISTS launch_coin_immutable ON launch_coins;
CREATE TRIGGER launch_coin_immutable BEFORE UPDATE OR DELETE ON launch_coins FOR EACH ROW EXECUTE FUNCTION rinsed_reject_registry_reassignment();
DROP TRIGGER IF EXISTS launch_intent_immutable ON pending_launch_intents;
CREATE TRIGGER launch_intent_immutable BEFORE UPDATE ON pending_launch_intents FOR EACH ROW EXECUTE FUNCTION rinsed_reject_registry_reassignment();
DROP TRIGGER IF EXISTS launch_migration_immutable ON launch_migrations;
CREATE TRIGGER launch_migration_immutable BEFORE UPDATE OR DELETE ON launch_migrations FOR EACH ROW EXECUTE FUNCTION rinsed_reject_registry_reassignment();
DROP TRIGGER IF EXISTS launch_migration_proof_immutable ON launch_migration_proofs;
CREATE TRIGGER launch_migration_proof_immutable BEFORE UPDATE OR DELETE ON launch_migration_proofs FOR EACH ROW EXECUTE FUNCTION rinsed_reject_registry_reassignment();
