CREATE TABLE IF NOT EXISTS wallet_profiles(
 wallet varchar(44) PRIMARY KEY,
 username varchar(24) NOT NULL UNIQUE CHECK(username~'^[a-z][a-z0-9_]{2,23}$'),
 bio varchar(280) NOT NULL DEFAULT '',
 avatar_url varchar(500) NOT NULL DEFAULT '',
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(length(bio)<=280 AND length(avatar_url)<=500)
);
CREATE TABLE IF NOT EXISTS wallet_social_challenges(
 nonce char(64) PRIMARY KEY CHECK(nonce~'^[a-f0-9]{64}$'),
 wallet varchar(44) NOT NULL,
 purpose text NOT NULL CHECK(purpose IN('profile','callout')),
 origin varchar(250) NOT NULL,
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 message text NOT NULL CHECK(length(message)<=2400),
 expires_at timestamptz NOT NULL,
 used_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wallet_social_challenges_expiry ON wallet_social_challenges(expires_at);
CREATE TABLE IF NOT EXISTS wallet_social_limits(
 bucket varchar(100) PRIMARY KEY,
 attempts integer NOT NULL CHECK(attempts>0),
 expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS token_callouts(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 network_genesis varchar(64) NOT NULL,
 mint varchar(44) NOT NULL,
 wallet varchar(44) NOT NULL,
 body varchar(500) NOT NULL CHECK(length(trim(body)) BETWEEN 1 AND 500),
 challenge_nonce char(64) NOT NULL UNIQUE REFERENCES wallet_social_challenges(nonce),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(network_genesis,mint) REFERENCES launch_coins(network_genesis,mint)
);
CREATE INDEX IF NOT EXISTS token_callouts_feed ON token_callouts(network_genesis,mint,id DESC);
CREATE INDEX IF NOT EXISTS token_callouts_wallet_rate ON token_callouts(wallet,created_at DESC);
