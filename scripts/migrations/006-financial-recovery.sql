-- Preserve every unsigned operator attempt before a proven-expired blockhash refresh.
CREATE TABLE IF NOT EXISTS financial_operator_attempts (
  plan_id uuid NOT NULL REFERENCES financial_operator_plans(id),
  message_digest char(64) NOT NULL,
  transaction_base64 text NOT NULL,
  last_valid_block_height bigint NOT NULL,
  finalized_expiry_height bigint NOT NULL,
  finalized_expiry_slot bigint NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(plan_id,message_digest)
);
DROP TRIGGER IF EXISTS financial_operator_attempts_immutable ON financial_operator_attempts;
CREATE TRIGGER financial_operator_attempts_immutable BEFORE UPDATE OR DELETE ON financial_operator_attempts
  FOR EACH ROW EXECUTE FUNCTION rinsed_financial_immutable();
