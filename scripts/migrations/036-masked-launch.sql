-- One Masked launch type: SOL pair, a creator/holder split chosen in 10% steps and locked at launch,
-- and a separate $MSKD buyback share. Earlier modes stay valid for coins already registered.
ALTER TABLE launch_configs DROP CONSTRAINT launch_configs_policy_version_check;
ALTER TABLE launch_configs ADD CONSTRAINT launch_configs_policy_version_check
 CHECK(policy_version IN ('rinse-v1','legacy-devnet','wallet-v1','bond-v1','mskd-v1','dev-v1','cashback-v1','hsol-v1','cashback-hsol-v1','mskd-hsol-v1','masked-v1'));
ALTER TABLE launch_coins DROP CONSTRAINT launch_coins_policy_version_check;
ALTER TABLE launch_coins ADD CONSTRAINT launch_coins_policy_version_check
 CHECK(policy_version IN ('rinse-v1','legacy-devnet','wallet-v1','bond-v1','mskd-v1','dev-v1','cashback-v1','hsol-v1','cashback-hsol-v1','mskd-hsol-v1','masked-v1'));
ALTER TABLE launch_coins DROP CONSTRAINT launch_coins_mode_check;
ALTER TABLE launch_coins ADD CONSTRAINT launch_coins_mode_check
 CHECK(mode IN ('creator','community','bond','mskd','dev','cashback','hsol','cashback-hsol','mskd-hsol','masked'));
ALTER TABLE pending_launch_intents DROP CONSTRAINT pending_launch_intents_mode_check;
ALTER TABLE pending_launch_intents ADD CONSTRAINT pending_launch_intents_mode_check
 CHECK(mode IN ('creator','community','bond','mskd','dev','cashback','hsol','cashback-hsol','mskd-hsol','masked'));
ALTER TABLE launch_coins DROP CONSTRAINT launch_coins_bond_time;
ALTER TABLE launch_coins ADD CONSTRAINT launch_coins_bond_time
 CHECK(policy_version NOT IN ('bond-v1','mskd-v1','dev-v1','cashback-v1','hsol-v1','cashback-hsol-v1','mskd-hsol-v1','masked-v1') OR activation_time IS NOT NULL);

-- Masked collects the whole non-protocol share and pays creator and holders, so its collector receives the fees.
ALTER TABLE launch_coins DROP CONSTRAINT launch_coins_recipient_policy;
ALTER TABLE launch_coins ADD CONSTRAINT launch_coins_recipient_policy
 CHECK(mode IN('community','cashback','mskd','cashback-hsol','mskd-hsol','masked') OR recipient=original_deployer);

-- The creator's share of the 0.6%, in basis points of that share. Present exactly for Masked coins.
ALTER TABLE pending_launch_intents ADD COLUMN creator_share_bps smallint;
ALTER TABLE pending_launch_intents ADD CONSTRAINT pending_launch_intents_creator_share CHECK(
 (mode='masked')=(creator_share_bps IS NOT NULL)
 AND (creator_share_bps IS NULL OR (creator_share_bps BETWEEN 0 AND 10000 AND creator_share_bps % 1000 = 0)));
ALTER TABLE launch_coins ADD COLUMN creator_share_bps smallint;
ALTER TABLE launch_coins ADD CONSTRAINT launch_coins_creator_share CHECK(
 (mode='masked')=(creator_share_bps IS NOT NULL)
 AND (creator_share_bps IS NULL OR (creator_share_bps BETWEEN 0 AND 10000 AND creator_share_bps % 1000 = 0)));

CREATE OR REPLACE FUNCTION check_bond_launch_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cfg launch_configs%ROWTYPE;
BEGIN
 SELECT * INTO STRICT cfg FROM launch_configs
 WHERE network_genesis=NEW.network_genesis AND config_key=NEW.config_key;
 IF NEW.mode IN ('creator','community') THEN
  IF cfg.policy_version NOT IN ('wallet-v1','rinse-v1','legacy-devnet') THEN
   RAISE EXCEPTION 'Historical mode requires a historical configuration';
  END IF;
 ELSIF cfg.policy_version IS DISTINCT FROM NEW.mode || '-v1' THEN
  RAISE EXCEPTION 'Launch mode differs from the registered economic policy';
 END IF;
 IF TG_TABLE_NAME='launch_coins' THEN
  IF (NEW.policy_version,NEW.quote_mint) IS DISTINCT FROM (cfg.policy_version,cfg.quote_mint) THEN
   RAISE EXCEPTION 'Coin policy or quote mint differs from its registered configuration';
  END IF;
  IF NEW.mode IN('cashback','mskd','cashback-hsol','mskd-hsol','masked') AND NEW.recipient IS DISTINCT FROM cfg.expected_fee_claimer THEN
   RAISE EXCEPTION 'Holder rewards must use the registered fee collector';
  END IF;
 END IF;
 RETURN NEW;
END $$;
