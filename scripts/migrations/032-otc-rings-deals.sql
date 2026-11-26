CREATE TABLE otc_rings_deals (
 offer_id uuid PRIMARY KEY REFERENCES confidential_otc_offers(id) ON DELETE RESTRICT,
 network_genesis text NOT NULL,
 maker varchar(44) NOT NULL,
 taker varchar(44) NOT NULL CHECK (maker <> taker),
 revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
 ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 30 AND 65536),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otc_rings_deals_maker ON otc_rings_deals(network_genesis,maker,created_at DESC);
CREATE INDEX otc_rings_deals_taker ON otc_rings_deals(network_genesis,taker,created_at DESC);
