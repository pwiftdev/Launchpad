ALTER TABLE wallet_social_challenges DROP CONSTRAINT wallet_social_challenges_purpose_check;
ALTER TABLE wallet_social_challenges ADD CONSTRAINT wallet_social_challenges_purpose_check
 CHECK(purpose IN('profile','callout','chat'));

CREATE TABLE token_chat_messages(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 network_genesis text NOT NULL,
 mint varchar(44) NOT NULL,
 author varchar(16) NOT NULL CHECK(author~'^[a-f0-9]{16}$'),
 client_id uuid NOT NULL,
 ciphertext bytea NOT NULL CHECK(octet_length(ciphertext) BETWEEN 30 AND 2029),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(network_genesis,mint,author,client_id),
 FOREIGN KEY(network_genesis,mint) REFERENCES launch_coins(network_genesis,mint)
);
CREATE INDEX token_chat_messages_feed ON token_chat_messages(network_genesis,mint,id DESC);
