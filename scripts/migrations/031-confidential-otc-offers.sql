ALTER TABLE wallet_social_challenges DROP CONSTRAINT wallet_social_challenges_purpose_check;
ALTER TABLE wallet_social_challenges ADD CONSTRAINT wallet_social_challenges_purpose_check
 CHECK(purpose IN('profile','callout','chat','launch-preview','otc'));

CREATE TABLE confidential_otc_offers(
 id uuid PRIMARY KEY,
 network_genesis text NOT NULL,
 owner varchar(44) NOT NULL,
 viewer_wallet varchar(44),
 token_hash char(64) NOT NULL UNIQUE CHECK(token_hash~'^[a-f0-9]{64}$'),
 expires_at timestamptz NOT NULL,
 ciphertext bytea NOT NULL CHECK(octet_length(ciphertext) BETWEEN 30 AND 512)
);
CREATE INDEX confidential_otc_offers_owner ON confidential_otc_offers(network_genesis,owner,expires_at);
CREATE INDEX confidential_otc_offers_expiry ON confidential_otc_offers(expires_at);
