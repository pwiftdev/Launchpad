CREATE TABLE IF NOT EXISTS whitelist_entries (
  wallet varchar(44) PRIMARY KEY,
  registration_id uuid NOT NULL UNIQUE,
  interest text NOT NULL CHECK (interest IN ('trader', 'creator', 'both')),
  status text NOT NULL DEFAULT 'registered' CHECK (status IN ('registered', 'approved', 'revoked')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  signed_message text NOT NULL,
  signature varchar(88) NOT NULL,
  policy_version text NOT NULL DEFAULT 'early-access-v1'
);
CREATE INDEX IF NOT EXISTS whitelist_entries_joined ON whitelist_entries(joined_at);
CREATE TABLE IF NOT EXISTS whitelist_challenges (
  nonce char(64) PRIMARY KEY,
  wallet varchar(44) NOT NULL,
  interest text NOT NULL CHECK (interest IN ('trader', 'creator', 'both')),
  message text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS whitelist_challenges_expiry ON whitelist_challenges(expires_at);
CREATE TABLE IF NOT EXISTS whitelist_limits (
  bucket char(64) PRIMARY KEY,
  attempts integer NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS whitelist_limits_expiry ON whitelist_limits(expires_at);
