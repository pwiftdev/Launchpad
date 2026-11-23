CREATE TABLE IF NOT EXISTS financial_funding_recoveries (
  plan_id uuid NOT NULL REFERENCES financial_operator_plans(id),
  old_signature varchar(88) NOT NULL,
  old_message_digest char(64) NOT NULL,
  old_transaction_base64 text NOT NULL,
  old_metadata jsonb NOT NULL,
  new_message_digest char(64) NOT NULL,
  new_transaction_base64 text NOT NULL,
  commitment char(64) NOT NULL,
  finalized_expiry_height bigint NOT NULL,
  finalized_proof_slot bigint NOT NULL,
  observed_unallocated numeric(78,0) NOT NULL CHECK(observed_unallocated>0),
  recovered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(plan_id,old_signature)
);
DROP TRIGGER IF EXISTS financial_funding_recoveries_immutable ON financial_funding_recoveries;
CREATE TRIGGER financial_funding_recoveries_immutable BEFORE UPDATE OR DELETE ON financial_funding_recoveries
  FOR EACH ROW EXECUTE FUNCTION rinsed_financial_immutable();
