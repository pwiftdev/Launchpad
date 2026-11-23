-- Keep the original local rational-category audit facts; fixed-Q128 categories are a new policy.
ALTER TABLE financial_damm_claim_windows ADD COLUMN IF NOT EXISTS classification_policy text NOT NULL
  DEFAULT 'rational-ownership-v1' CHECK(classification_policy IN ('rational-ownership-v1','q128-growth-v1'));
DO $$ BEGIN
  IF (SELECT array_length(conkey,1) FROM pg_constraint
      WHERE conrelid='financial_damm_claim_windows'::regclass AND conname='financial_damm_claim_windows_pkey')=3 THEN
    ALTER TABLE financial_damm_claim_windows DROP CONSTRAINT financial_damm_claim_windows_pkey;
    ALTER TABLE financial_damm_claim_windows ADD PRIMARY KEY(network_genesis,mint,claim_signature,classification_policy);
  END IF;
END $$;
