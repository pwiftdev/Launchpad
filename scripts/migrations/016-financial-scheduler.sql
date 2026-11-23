-- Operational progress only; never a funding, payout or signing authority.
CREATE TABLE IF NOT EXISTS financial_scheduler_state (
  network_genesis varchar(64) NOT NULL,
  program_id varchar(44) NOT NULL,
  cursor_mint varchar(44),
  last_started_at timestamptz,
  last_completed_at timestamptz,
  last_progress_at timestamptz,
  last_status text NOT NULL CHECK(last_status IN ('running','completed','stopped','failed')),
  last_processed integer NOT NULL DEFAULT 0 CHECK(last_processed>=0),
  last_failed integer NOT NULL DEFAULT 0 CHECK(last_failed>=0),
  PRIMARY KEY(network_genesis,program_id)
);
