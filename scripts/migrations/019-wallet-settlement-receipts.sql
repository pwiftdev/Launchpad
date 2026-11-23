CREATE TABLE IF NOT EXISTS wallet_settlements(
 job_id uuid PRIMARY KEY REFERENCES wallet_jobs(id),
 network_genesis text NOT NULL,mint varchar(44) NOT NULL,
 kind text NOT NULL CHECK(kind IN('collect','buyback','creator_claim','community_claim','platform_claim','setup')),
 signature varchar(88) NOT NULL UNIQUE,message_digest char(64) NOT NULL CHECK(message_digest~'^[a-f0-9]{64}$'),
 finalized_slot bigint NOT NULL CHECK(finalized_slot>=0),
 received_lamports numeric(78,0) NOT NULL CHECK(received_lamports>=0),
 paid_lamports numeric(78,0) NOT NULL CHECK(paid_lamports>=0),
 actual_spent_lamports numeric(78,0) NOT NULL CHECK(actual_spent_lamports>=0),
 burned_tokens numeric(78,0) NOT NULL CHECK(burned_tokens>=0),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(network_genesis,mint) REFERENCES launch_coins(network_genesis,mint),
 CHECK((kind='collect' AND received_lamports>0 AND paid_lamports=0 AND actual_spent_lamports=0 AND burned_tokens=0)
 OR(kind='buyback' AND received_lamports=0 AND paid_lamports=0 AND actual_spent_lamports>0 AND burned_tokens>0)
 OR(kind IN('creator_claim','community_claim','platform_claim') AND received_lamports=0 AND paid_lamports>0 AND actual_spent_lamports IN(0,paid_lamports) AND burned_tokens=0)
 OR(kind='setup' AND received_lamports=0 AND paid_lamports=0 AND actual_spent_lamports=0 AND burned_tokens=0))
);
DROP TRIGGER IF EXISTS wallet_settlements_immutable ON wallet_settlements;
CREATE TRIGGER wallet_settlements_immutable BEFORE UPDATE OR DELETE ON wallet_settlements
 FOR EACH ROW EXECUTE FUNCTION rinsed_wallet_immutable();
