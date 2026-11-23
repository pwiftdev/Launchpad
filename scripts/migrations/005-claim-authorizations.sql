-- Signed preparation intents are durable and idempotent across processes/restarts.
CREATE TABLE IF NOT EXISTS financial_wallet_authorizations (
  wallet varchar(44) NOT NULL,
  request_id uuid NOT NULL,
  message_digest char(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(wallet,request_id)
);
CREATE INDEX IF NOT EXISTS financial_wallet_authorizations_expiry
  ON financial_wallet_authorizations(expires_at);
