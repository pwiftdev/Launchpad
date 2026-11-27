-- Public proof for Masked. The operator publishes what anyone needs to audit the Monero
-- treasury: its primary address and private view key (which shows incoming funds), and signed
-- key images (which show what was spent). It also records XMR received, so the proof page can
-- show XMR bought next to XMR paid. None of this can move funds.
CREATE TABLE IF NOT EXISTS masked_treasury_keys(
 network_genesis text PRIMARY KEY,
 primary_address varchar(106) NOT NULL CHECK(length(primary_address) IN(95,106)),
 view_key char(64) NOT NULL CHECK(view_key~'^[a-f0-9]{64}$'),
 restore_height bigint CHECK(restore_height IS NULL OR restore_height>=0),
 published_at timestamptz NOT NULL DEFAULT now()
);

-- Signed key-image exports, newest last. An auditor imports one into a view-only wallet.
CREATE TABLE IF NOT EXISTS masked_key_image_exports(
 id uuid PRIMARY KEY,
 network_genesis text NOT NULL,
 wallet_height bigint NOT NULL CHECK(wallet_height>=0),
 key_image_count integer NOT NULL CHECK(key_image_count>=0),
 export_offset integer NOT NULL CHECK(export_offset>=0),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='array'),
 digest char(64) NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(network_genesis,digest)
);
CREATE INDEX IF NOT EXISTS masked_key_image_exports_latest ON masked_key_image_exports(network_genesis,created_at DESC);

-- XMR that arrived in the treasury: the top-ups bought with company SOL.
CREATE TABLE IF NOT EXISTS masked_xmr_inflows(
 network_genesis text NOT NULL,
 txid char(64) NOT NULL CHECK(txid~'^[a-f0-9]{64}$'),
 amount_atomic numeric(39,0) NOT NULL CHECK(amount_atomic>0),
 height bigint NOT NULL CHECK(height>=0),
 received_at timestamptz NOT NULL,
 PRIMARY KEY(network_genesis,txid)
);
CREATE INDEX IF NOT EXISTS masked_xmr_inflows_time ON masked_xmr_inflows(network_genesis,received_at);

DROP TRIGGER IF EXISTS masked_key_image_exports_immutable ON masked_key_image_exports;
CREATE TRIGGER masked_key_image_exports_immutable BEFORE UPDATE OR DELETE ON masked_key_image_exports
 FOR EACH ROW EXECUTE FUNCTION rinsed_wallet_immutable();
DROP TRIGGER IF EXISTS masked_xmr_inflows_immutable ON masked_xmr_inflows;
CREATE TRIGGER masked_xmr_inflows_immutable BEFORE UPDATE OR DELETE ON masked_xmr_inflows
 FOR EACH ROW EXECUTE FUNCTION rinsed_wallet_immutable();
