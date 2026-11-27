-- 0.10% of every Masked trade buys back and burns $MSKD. Each Masked coin's accrued share moves
-- in the ledger to the official $MSKD coin's buyback budget, where the existing buyback job buys
-- $MSKD from its pool and burns it. Both coins share the company collector, so no SOL moves here.
CREATE TABLE IF NOT EXISTS masked_mskd_buyback_transfers(
 id uuid PRIMARY KEY,
 network_genesis text NOT NULL,
 source_mint varchar(44) NOT NULL,
 target_mint varchar(44) NOT NULL,
 lamports numeric(78,0) NOT NULL CHECK(lamports>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(source_mint<>target_mint),
 FOREIGN KEY(network_genesis,source_mint) REFERENCES launch_coins(network_genesis,mint),
 FOREIGN KEY(network_genesis,target_mint) REFERENCES launch_coins(network_genesis,mint)
);
CREATE INDEX IF NOT EXISTS masked_mskd_buyback_transfers_source
 ON masked_mskd_buyback_transfers(network_genesis,source_mint,created_at);
DROP TRIGGER IF EXISTS masked_mskd_buyback_transfers_immutable ON masked_mskd_buyback_transfers;
CREATE TRIGGER masked_mskd_buyback_transfers_immutable BEFORE UPDATE OR DELETE ON masked_mskd_buyback_transfers
 FOR EACH ROW EXECUTE FUNCTION rinsed_wallet_immutable();
