ALTER TABLE launch_coins DROP CONSTRAINT IF EXISTS launch_coins_check;
ALTER TABLE launch_coins ADD CONSTRAINT launch_coins_recipient_policy
 CHECK(mode IN('community','cashback','mskd') OR recipient=original_deployer);

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
  IF NEW.mode IN('cashback','mskd') AND NEW.recipient IS DISTINCT FROM cfg.expected_fee_claimer THEN
   RAISE EXCEPTION 'Holder rewards must use the registered fee collector';
  END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE TABLE wallet_claim_allocations (
 job_id uuid NOT NULL REFERENCES wallet_jobs(id),
 network_genesis text NOT NULL,
 mint varchar(44) NOT NULL,
 epoch bigint NOT NULL,
 wallet varchar(44) NOT NULL,
 PRIMARY KEY(job_id,epoch),
 FOREIGN KEY(network_genesis,mint,epoch,wallet)
  REFERENCES wallet_allocations(network_genesis,mint,epoch,wallet)
);
CREATE INDEX wallet_claim_allocations_entitlement
 ON wallet_claim_allocations(network_genesis,mint,wallet,epoch);
CREATE INDEX wallet_allocations_by_wallet
 ON wallet_allocations(network_genesis,mint,wallet,epoch DESC);
CREATE TRIGGER wallet_claim_allocations_immutable BEFORE UPDATE OR DELETE ON wallet_claim_allocations
 FOR EACH ROW EXECUTE FUNCTION rinsed_wallet_immutable();

ALTER TABLE wallet_epochs ADD COLUMN snapshot_exclusions jsonb
 CHECK(jsonb_typeof(snapshot_exclusions)='array');
