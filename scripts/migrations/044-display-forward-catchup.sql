ALTER TABLE display_pool_cursors
  ADD COLUMN forward_head varchar(88),
  ADD COLUMN forward_before varchar(88),
  ADD CONSTRAINT display_pool_forward_pair CHECK ((forward_head IS NULL) = (forward_before IS NULL));

UPDATE display_pool_cursors
SET backfill_before = newest_signature, backfill_complete = false
WHERE newest_signature IS NOT NULL;
