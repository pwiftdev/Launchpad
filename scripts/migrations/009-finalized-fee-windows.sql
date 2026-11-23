CREATE TABLE IF NOT EXISTS financial_damm_claim_windows (
  network_genesis text NOT NULL,
  mint varchar(44) NOT NULL,
  pool varchar(44) NOT NULL,
  claim_signature varchar(88) NOT NULL,
  window_digest char(64) NOT NULL,
  event_identity_digest char(64) NOT NULL,
  events integer NOT NULL CHECK(events>0),
  raw_pool_fees numeric(78,0) NOT NULL CHECK(raw_pool_fees>=0),
  realized_owned numeric(78,0) NOT NULL CHECK(realized_owned>=0),
  external_lp_excluded numeric(78,0) NOT NULL CHECK(external_lp_excluded>=0),
  rounding_loss numeric(78,0) NOT NULL CHECK(rounding_loss>=0),
  rounding_bound numeric(78,0) NOT NULL CHECK(rounding_bound>=0),
  proof jsonb NOT NULL,
  verified_slot bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(network_genesis,mint,claim_signature),
  FOREIGN KEY(network_genesis,mint) REFERENCES launch_coins(network_genesis,mint),
  CHECK(raw_pool_fees=realized_owned+external_lp_excluded+rounding_loss), CHECK(rounding_loss<=rounding_bound)
);
DROP TRIGGER IF EXISTS financial_damm_claim_windows_immutable ON financial_damm_claim_windows;
CREATE TRIGGER financial_damm_claim_windows_immutable BEFORE UPDATE OR DELETE ON financial_damm_claim_windows
  FOR EACH ROW EXECUTE FUNCTION rinsed_financial_immutable();
