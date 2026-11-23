CREATE TABLE IF NOT EXISTS financial_claim_attempts (
  job_id uuid NOT NULL REFERENCES financial_jobs(id),
  signature varchar(88) NOT NULL,
  message_digest char(64) NOT NULL,
  transaction_base64 text NOT NULL,
  last_valid_block_height bigint NOT NULL,
  previous_status text NOT NULL,
  finalized_expiry_height bigint NOT NULL,
  finalized_proof_slot bigint NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(job_id,signature)
);
DROP TRIGGER IF EXISTS financial_claim_attempts_immutable ON financial_claim_attempts;
CREATE TRIGGER financial_claim_attempts_immutable BEFORE UPDATE OR DELETE ON financial_claim_attempts
  FOR EACH ROW EXECUTE FUNCTION rinsed_financial_immutable();
