-- Metadata upload authorizations and provider-cost budgets survive web restarts/scaling.
-- Store only signature digests and public wallet addresses, never raw signatures or IPs.
CREATE TABLE IF NOT EXISTS launch_upload_authorizations (
  authorization_digest char(64) PRIMARY KEY CHECK (authorization_digest ~ '^[a-f0-9]{64}$'),
  wallet varchar(44) NOT NULL CHECK (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  consumed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes')
);
CREATE INDEX IF NOT EXISTS launch_upload_authorizations_expiry
  ON launch_upload_authorizations(expires_at);

CREATE TABLE IF NOT EXISTS launch_upload_budgets (
  bucket varchar(51) PRIMARY KEY,
  attempts integer NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '1 hour'),
  CHECK ((bucket = 'global' AND attempts BETWEEN 1 AND 20) OR
    (bucket ~ '^wallet:[1-9A-HJ-NP-Za-km-z]{32,44}$' AND attempts BETWEEN 1 AND 3))
);
CREATE INDEX IF NOT EXISTS launch_upload_budgets_expiry ON launch_upload_budgets(expires_at);
