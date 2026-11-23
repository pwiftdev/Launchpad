-- Untrusted display copy, independent of launch authority and fee policy.
DO $$
DECLARE shape_constraint text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='offchain_metadata_cache'::regclass
    AND conname='offchain_metadata_display_shape') THEN RETURN; END IF;
  SELECT conname INTO STRICT shape_constraint FROM pg_constraint
  WHERE conrelid='offchain_metadata_cache'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%jsonb_typeof(value)%'
    AND pg_get_constraintdef(oid) LIKE '%{}%';
  EXECUTE format('ALTER TABLE offchain_metadata_cache DROP CONSTRAINT %I', shape_constraint);
  ALTER TABLE offchain_metadata_cache ADD CONSTRAINT offchain_metadata_display_shape
    CHECK (jsonb_typeof(value)='object' AND value ? 'image' AND value ? 'source'
      AND value - 'image' - 'source' - 'description' = '{}'::jsonb
      AND (NOT (value ? 'description') OR
        (jsonb_typeof(value->'description')='string' AND octet_length(value->>'description')<=4000)));
  -- Retain artwork while refreshing once after the display contract expands.
  UPDATE offchain_metadata_cache SET refresh_at='epoch', retry_at='epoch';
END $$;
