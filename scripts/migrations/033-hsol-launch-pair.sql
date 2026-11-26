ALTER TABLE launch_configs DROP CONSTRAINT launch_configs_policy_version_check;
ALTER TABLE launch_configs ADD CONSTRAINT launch_configs_policy_version_check
 CHECK(policy_version IN ('rinse-v1','legacy-devnet','wallet-v1','bond-v1','mskd-v1','dev-v1','cashback-v1','hsol-v1'));
ALTER TABLE launch_configs DROP CONSTRAINT launch_config_quote_policy;
ALTER TABLE launch_configs ADD CONSTRAINT launch_config_quote_policy CHECK(
  (policy_version <> 'hsol-v1' AND quote_mint = 'So11111111111111111111111111111111111111112') OR
  (policy_version = 'hsol-v1' AND network_genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
   AND quote_mint = 'he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A')
);
ALTER TABLE launch_coins DROP CONSTRAINT launch_coins_policy_version_check;
ALTER TABLE launch_coins ADD CONSTRAINT launch_coins_policy_version_check
 CHECK(policy_version IN ('rinse-v1','legacy-devnet','wallet-v1','bond-v1','mskd-v1','dev-v1','cashback-v1','hsol-v1'));
ALTER TABLE launch_coins DROP CONSTRAINT launch_coins_mode_check;
ALTER TABLE launch_coins ADD CONSTRAINT launch_coins_mode_check
 CHECK(mode IN ('creator','community','bond','mskd','dev','cashback','hsol'));
ALTER TABLE pending_launch_intents DROP CONSTRAINT pending_launch_intents_mode_check;
ALTER TABLE pending_launch_intents ADD CONSTRAINT pending_launch_intents_mode_check
 CHECK(mode IN ('creator','community','bond','mskd','dev','cashback','hsol'));
ALTER TABLE launch_coins DROP CONSTRAINT launch_coins_bond_time;
ALTER TABLE launch_coins ADD CONSTRAINT launch_coins_bond_time
 CHECK(policy_version NOT IN ('bond-v1','mskd-v1','dev-v1','cashback-v1','hsol-v1') OR activation_time IS NOT NULL);
