-- Content-addressed display artwork survives gateway failures and web dyno restarts.
CREATE TABLE IF NOT EXISTS token_image_cache (
  uri_digest char(64) PRIMARY KEY CHECK(uri_digest~'^[a-f0-9]{64}$'),
  uri text NOT NULL CHECK(octet_length(uri)<=2048),
  image bytea NOT NULL CHECK(octet_length(image)>0 AND octet_length(image)<=524288),
  accessed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS token_image_cache_accessed ON token_image_cache(accessed_at,uri_digest);
