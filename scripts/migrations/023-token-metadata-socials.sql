-- Match the sanitized display fields emitted by the metadata reader and upload API.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='offchain_metadata_cache'::regclass
    AND conname='offchain_metadata_display_shape' AND pg_get_constraintdef(oid) LIKE '%website%')
    THEN RETURN; END IF;
  ALTER TABLE offchain_metadata_cache DROP CONSTRAINT offchain_metadata_display_shape;
  ALTER TABLE offchain_metadata_cache ADD CONSTRAINT offchain_metadata_display_shape
    CHECK (jsonb_typeof(value)='object' AND value ? 'image' AND value ? 'source'
      AND value - 'image' - 'source' - 'description' - 'website' - 'twitter' - 'telegram' - 'discord' = '{}'::jsonb
      AND (NOT (value ? 'description') OR
        (jsonb_typeof(value->'description')='string' AND octet_length(value->>'description')<=4000))
      AND (NOT (value ? 'website') OR
        (jsonb_typeof(value->'website')='string' AND octet_length(value->>'website')<=2048 AND value->>'website' LIKE 'https://%'))
      AND (NOT (value ? 'twitter') OR
        (jsonb_typeof(value->'twitter')='string' AND octet_length(value->>'twitter')<=2048 AND value->>'twitter' LIKE 'https://%'))
      AND (NOT (value ? 'telegram') OR
        (jsonb_typeof(value->'telegram')='string' AND octet_length(value->>'telegram')<=2048 AND value->>'telegram' LIKE 'https://%'))
      AND (NOT (value ? 'discord') OR
        (jsonb_typeof(value->'discord')='string' AND octet_length(value->>'discord')<=2048 AND value->>'discord' LIKE 'https://%')));
  -- Keep previously saved artwork and permit the rejected metadata to refresh immediately.
  UPDATE offchain_metadata_cache SET refresh_at='epoch', retry_at='epoch';
END $$;
