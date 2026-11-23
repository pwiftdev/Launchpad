CREATE TABLE IF NOT EXISTS financial_damm_replay_checkpoints (
  network_genesis text NOT NULL,
  program_id varchar(44) NOT NULL,
  mint varchar(44) NOT NULL,
  pool varchar(44) NOT NULL,
  position varchar(44) NOT NULL,
  classification_policy text NOT NULL CHECK(classification_policy='q128-growth-v1'),
  checkpoint_digest char(64) NOT NULL,
  payload_digest char(64) NOT NULL,
  mac varchar(128) NOT NULL,
  cursor_signature varchar(88) NOT NULL,
  cursor_slot bigint NOT NULL CHECK(cursor_slot>=0),
  cursor_transaction_index integer NOT NULL CHECK(cursor_transaction_index>=0),
  previous_checkpoint_digest char(64),
  rolling_history_digest char(64) NOT NULL,
  verified_snapshot_slot bigint NOT NULL CHECK(verified_snapshot_slot>=cursor_slot),
  pool_digest char(64) NOT NULL,
  position_digest char(64) NOT NULL,
  payload jsonb NOT NULL,
  envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(network_genesis,program_id,mint,pool,position,classification_policy,checkpoint_digest),
  UNIQUE(network_genesis,program_id,mint,pool,position,classification_policy,cursor_signature),
  FOREIGN KEY(network_genesis,mint) REFERENCES launch_coins(network_genesis,mint),
  FOREIGN KEY(network_genesis,program_id,mint,pool,position,classification_policy,previous_checkpoint_digest)
    REFERENCES financial_damm_replay_checkpoints(network_genesis,program_id,mint,pool,position,classification_policy,checkpoint_digest)
);
CREATE INDEX IF NOT EXISTS financial_damm_checkpoint_latest ON financial_damm_replay_checkpoints
  (network_genesis,program_id,mint,pool,position,classification_policy,cursor_slot DESC,cursor_transaction_index DESC);
CREATE INDEX IF NOT EXISTS financial_damm_checkpoint_attributions ON financial_damm_replay_checkpoints USING gin((payload->'attributions') jsonb_path_ops);
DROP TRIGGER IF EXISTS financial_damm_replay_checkpoints_immutable ON financial_damm_replay_checkpoints;
CREATE TRIGGER financial_damm_replay_checkpoints_immutable BEFORE UPDATE OR DELETE ON financial_damm_replay_checkpoints
  FOR EACH ROW EXECUTE FUNCTION rinsed_financial_immutable();
