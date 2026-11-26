ALTER TABLE wallet_social_challenges DROP CONSTRAINT wallet_social_challenges_purpose_check;
ALTER TABLE wallet_social_challenges ADD CONSTRAINT wallet_social_challenges_purpose_check
 CHECK(purpose IN('profile','callout','chat','launch-preview'));

CREATE TABLE launch_preview_drafts(
 network_genesis text NOT NULL,
 owner varchar(44) NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 ciphertext bytea NOT NULL CHECK(octet_length(ciphertext) BETWEEN 30 AND 2810000),
 PRIMARY KEY(network_genesis,owner)
);

CREATE TABLE launch_preview_invites(
 id uuid PRIMARY KEY,
 network_genesis text NOT NULL,
 owner varchar(44) NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 token_hash char(64) NOT NULL UNIQUE CHECK(token_hash~'^[a-f0-9]{64}$'),
 viewer_wallet varchar(44),
 expires_at timestamptz NOT NULL,
 FOREIGN KEY(network_genesis,owner) REFERENCES launch_preview_drafts(network_genesis,owner) ON DELETE CASCADE
);
CREATE INDEX launch_preview_invites_owner ON launch_preview_invites(network_genesis,owner,revision,expires_at);
CREATE INDEX launch_preview_invites_expiry ON launch_preview_invites(expires_at);
