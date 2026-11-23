-- Preserve the actual snapshot bank and one immutable allocation per completed calendar hour.
-- A delayed worker processes the current hour; it never fabricates an earlier holder snapshot.
ALTER TABLE wallet_epochs DROP CONSTRAINT IF EXISTS wallet_epochs_snapshot_time_check;
ALTER TABLE wallet_epochs DROP CONSTRAINT IF EXISTS wallet_epochs_check;
ALTER TABLE wallet_epochs ADD CONSTRAINT wallet_epochs_snapshot_time_check
 CHECK(snapshot_time>=0 AND snapshot_time/3600-1=epoch);
