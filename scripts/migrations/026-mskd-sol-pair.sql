-- MSKD mode pairs to SOL (owner decision 2026-11-23); its holder share is paid in wXMR off-chain.
-- 025 required mskd-v1 to use a non-SOL quote (hSOL). Every launch policy now pairs to SOL.
-- Fail loudly rather than reinterpret a registered hSOL configuration under the new rules.
DO $$
BEGIN
 IF EXISTS (
  SELECT 1 FROM launch_configs
  WHERE quote_mint<>'So11111111111111111111111111111111111111112'
 ) THEN
  RAISE EXCEPTION 'A non-SOL launch configuration is registered; review it before applying 026';
 END IF;
END $$;

ALTER TABLE launch_configs DROP CONSTRAINT IF EXISTS launch_config_quote_policy;
ALTER TABLE launch_configs ADD CONSTRAINT launch_config_quote_policy
 CHECK(quote_mint='So11111111111111111111111111111111111111112');
