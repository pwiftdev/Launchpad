-- Display metadata only. This table never supplies mint/config/fee authority.
CREATE TABLE IF NOT EXISTS offchain_metadata_cache (
  uri_digest text PRIMARY KEY CHECK (uri_digest ~ '^[a-f0-9]{64}$'),
  uri text NOT NULL CHECK (octet_length(uri) BETWEEN 1 AND 2048),
  value jsonb NOT NULL DEFAULT '{"image":null,"source":null}'::jsonb,
  fetched_at timestamptz,
  refresh_at timestamptz NOT NULL DEFAULT 'epoch',
  retry_at timestamptz NOT NULL DEFAULT 'epoch',
  lease_owner uuid,
  lease_until timestamptz,
  accessed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (jsonb_typeof(value)='object' AND value ? 'image' AND value ? 'source'
    AND value - 'image' - 'source' = '{}'::jsonb),
  CHECK ((value->'image'='null'::jsonb OR (jsonb_typeof(value->'image')='string' AND octet_length(value->>'image')<=2048))
    AND (value->'source'='null'::jsonb OR (jsonb_typeof(value->'source')='string' AND octet_length(value->>'source')<=2048))),
  CHECK ((lease_owner IS NULL) = (lease_until IS NULL))
);
CREATE INDEX IF NOT EXISTS offchain_metadata_cache_eviction ON offchain_metadata_cache(accessed_at);
