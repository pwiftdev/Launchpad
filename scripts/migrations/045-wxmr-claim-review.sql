ALTER TABLE masked_claims ADD COLUMN wxmr_retry_after timestamptz;

CREATE INDEX IF NOT EXISTS wallet_wxmr_claim_attempts
  ON wallet_jobs (network_genesis, (details->>'maskedClaim'), created_at DESC, id DESC)
  WHERE kind='wxmr_claim';
