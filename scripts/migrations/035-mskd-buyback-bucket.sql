-- 0.1% of every Masked trade buys back and burns $MSKD. It is held in its own bucket until spent.
-- Safe to reapply: every change checks what is already there.
ALTER TABLE wallet_balances DROP CONSTRAINT IF EXISTS wallet_balances_bucket_check;
ALTER TABLE wallet_balances ADD CONSTRAINT wallet_balances_bucket_check
 CHECK(bucket IN('rinse_buyback','creator','community','platform','mskd_buyback'));
ALTER TABLE wallet_jobs DROP CONSTRAINT IF EXISTS wallet_jobs_bucket_check;
ALTER TABLE wallet_jobs ADD CONSTRAINT wallet_jobs_bucket_check
 CHECK(bucket IN('rinse_buyback','creator','community','platform','mskd_buyback'));
ALTER TABLE wallet_collections ADD COLUMN IF NOT EXISTS mskd_buyback numeric(78,0) NOT NULL DEFAULT 0 CHECK(mskd_buyback>=0);
ALTER TABLE wallet_collections DROP CONSTRAINT IF EXISTS wallet_collections_check1;
ALTER TABLE wallet_collections DROP CONSTRAINT IF EXISTS wallet_collections_allocation;
ALTER TABLE wallet_collections ADD CONSTRAINT wallet_collections_allocation CHECK(
 received=rinse_net+post_net AND received=rinse_buyback+creator+community+platform+mskd_buyback);
