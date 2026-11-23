-- Raw swap evidence remains unchanged; fixed-point LP shortfalls never become a payable budget.
CREATE TABLE IF NOT EXISTS financial_funding_realizations (
  network_genesis text NOT NULL,
  mint varchar(44) NOT NULL,
  raw_commitment char(64) NOT NULL,
  realized_commitment char(64) NOT NULL,
  raw_expected numeric(78,0) NOT NULL CHECK(raw_expected>0),
  realized_net numeric(78,0) NOT NULL CHECK(realized_net>0),
  shortfall numeric(78,0) NOT NULL CHECK(shortfall>=0),
  external_lp_excluded numeric(78,0) NOT NULL DEFAULT 0 CHECK(external_lp_excluded>=0),
  rounding_loss numeric(78,0) NOT NULL DEFAULT 0 CHECK(rounding_loss>=0),
  proof_digest char(64) NOT NULL,
  proof jsonb NOT NULL,
  finalized_slot bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(network_genesis,mint,raw_commitment),
  UNIQUE(network_genesis,mint,realized_commitment),
  FOREIGN KEY(network_genesis,mint) REFERENCES launch_coins(network_genesis,mint),
  CHECK(raw_expected=realized_net+shortfall), CHECK(shortfall=external_lp_excluded+rounding_loss)
);
CREATE TABLE IF NOT EXISTS financial_funding_rounding (
  network_genesis text NOT NULL,
  mint varchar(44) NOT NULL,
  commitment char(64) NOT NULL,
  raw_expected numeric(78,0) NOT NULL,
  realized_net numeric(78,0) NOT NULL,
  shortfall numeric(78,0) NOT NULL CHECK(shortfall>=0),
  external_lp_excluded numeric(78,0) NOT NULL DEFAULT 0 CHECK(external_lp_excluded>=0),
  rounding_loss numeric(78,0) NOT NULL DEFAULT 0 CHECK(rounding_loss>=0),
  proof_digest char(64) NOT NULL,
  PRIMARY KEY(network_genesis,mint,commitment),
  FOREIGN KEY(network_genesis,mint,commitment) REFERENCES financial_funding(network_genesis,mint,commitment),
  CHECK(raw_expected=realized_net+shortfall), CHECK(shortfall=external_lp_excluded+rounding_loss)
);
ALTER TABLE financial_funding_realizations ADD COLUMN IF NOT EXISTS external_lp_excluded numeric(78,0) NOT NULL DEFAULT 0 CHECK(external_lp_excluded>=0);
ALTER TABLE financial_funding_realizations ADD COLUMN IF NOT EXISTS rounding_loss numeric(78,0) NOT NULL DEFAULT 0 CHECK(rounding_loss>=0);
ALTER TABLE financial_funding_rounding ADD COLUMN IF NOT EXISTS external_lp_excluded numeric(78,0) NOT NULL DEFAULT 0 CHECK(external_lp_excluded>=0);
ALTER TABLE financial_funding_rounding ADD COLUMN IF NOT EXISTS rounding_loss numeric(78,0) NOT NULL DEFAULT 0 CHECK(rounding_loss>=0);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='financial_funding_realizations'::regclass AND conname='realization_shortfall_conservation') THEN
    ALTER TABLE financial_funding_realizations ADD CONSTRAINT realization_shortfall_conservation CHECK(shortfall=external_lp_excluded+rounding_loss);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='financial_funding_rounding'::regclass AND conname='funded_shortfall_conservation') THEN
    ALTER TABLE financial_funding_rounding ADD CONSTRAINT funded_shortfall_conservation CHECK(shortfall=external_lp_excluded+rounding_loss);
  END IF;
END $$;
DROP TRIGGER IF EXISTS financial_funding_realizations_immutable ON financial_funding_realizations;
CREATE TRIGGER financial_funding_realizations_immutable BEFORE UPDATE OR DELETE ON financial_funding_realizations
  FOR EACH ROW EXECUTE FUNCTION rinsed_financial_immutable();
DROP TRIGGER IF EXISTS financial_funding_rounding_immutable ON financial_funding_rounding;
CREATE TRIGGER financial_funding_rounding_immutable BEFORE UPDATE OR DELETE ON financial_funding_rounding
  FOR EACH ROW EXECUTE FUNCTION rinsed_financial_immutable();
