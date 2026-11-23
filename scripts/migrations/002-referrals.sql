-- Referral codes and attribution for the early-access whitelist.
-- Each registration gets a short shareable code; referred_by records who invited a wallet.
ALTER TABLE whitelist_entries ADD COLUMN IF NOT EXISTS referral_code varchar(12);
ALTER TABLE whitelist_entries ADD COLUMN IF NOT EXISTS referred_by varchar(44);
CREATE UNIQUE INDEX IF NOT EXISTS whitelist_entries_referral_code ON whitelist_entries(referral_code);
-- Do not truncate receipt IDs: their first 8 characters can collide. Preserve existing codes
-- and retry random codes against the unique index. The default also supports the old web
-- process while this additive migration runs before the new release replaces it.
ALTER TABLE whitelist_entries ALTER COLUMN referral_code
  SET DEFAULT upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
DO $$
DECLARE entry_wallet varchar(44);
BEGIN
  FOR entry_wallet IN SELECT wallet FROM whitelist_entries WHERE referral_code IS NULL LOOP
    LOOP
      BEGIN
        UPDATE whitelist_entries
          SET referral_code = upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))
          WHERE wallet = entry_wallet AND referral_code IS NULL;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        -- Generate another code for this entry without changing anyone else's link.
        NULL;
      END;
    END LOOP;
  END LOOP;
END $$;
ALTER TABLE whitelist_entries ALTER COLUMN referral_code SET NOT NULL;
CREATE INDEX IF NOT EXISTS whitelist_entries_referred_by ON whitelist_entries(referred_by);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'whitelist_referrer_exists' AND conrelid = 'whitelist_entries'::regclass) THEN
    ALTER TABLE whitelist_entries ADD CONSTRAINT whitelist_referrer_exists
      FOREIGN KEY (referred_by) REFERENCES whitelist_entries(wallet) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'whitelist_referrer_not_self' AND conrelid = 'whitelist_entries'::regclass) THEN
    ALTER TABLE whitelist_entries ADD CONSTRAINT whitelist_referrer_not_self
      CHECK (referred_by IS NULL OR referred_by <> wallet);
  END IF;
END $$;
-- The invite travels with the signed challenge, so it is part of what the wallet signs
ALTER TABLE whitelist_challenges ADD COLUMN IF NOT EXISTS referral_code varchar(12);
