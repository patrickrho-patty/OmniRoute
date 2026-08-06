CREATE TABLE IF NOT EXISTS patty_settlement_outbox (
  request_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  preflight_ref TEXT NOT NULL,
  route_target TEXT NOT NULL,
  terminal_usage_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (request_id, turn_id)
);

CREATE INDEX IF NOT EXISTS idx_patty_settlement_outbox_due
  ON patty_settlement_outbox (next_attempt_at, attempts);
