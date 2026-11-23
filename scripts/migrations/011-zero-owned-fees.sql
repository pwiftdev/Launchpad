-- A positive raw pool fee can earn exactly zero to the program position. This is NOT funding.
CREATE TABLE IF NOT EXISTS financial_zero_fee_events (
  network_genesis text NOT NULL,
  mint varchar(44) NOT NULL,
  signature varchar(88) NOT NULL,
  instruction_index integer NOT NULL,
  event_index integer NOT NULL,
  raw_expected numeric(78,0) NOT NULL CHECK(raw_expected>0),
  realized_net numeric(78,0) NOT NULL DEFAULT 0 CHECK(realized_net=0),
  proof_digest char(64) NOT NULL,
  proof jsonb NOT NULL,
  finalized_slot bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(network_genesis,signature,instruction_index,event_index),
  FOREIGN KEY(network_genesis,mint) REFERENCES launch_coins(network_genesis,mint),
  FOREIGN KEY(network_genesis,signature,instruction_index,event_index)
    REFERENCES financial_fee_events(network_genesis,signature,instruction_index,event_index)
);
DROP TRIGGER IF EXISTS financial_zero_fee_events_immutable ON financial_zero_fee_events;
CREATE TRIGGER financial_zero_fee_events_immutable BEFORE UPDATE OR DELETE ON financial_zero_fee_events
  FOR EACH ROW EXECUTE FUNCTION rinsed_financial_immutable();
