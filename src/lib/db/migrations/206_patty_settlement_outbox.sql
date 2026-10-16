-- Patty settlement outbox (fork-only).
-- Renumbered 164 → 187: upstream's 164_retire_microsoft_designer_web took the slot
-- in the v3.8.51 sync. Databases that applied this under the old number are rehomed
-- by RENAMED_MIGRATION_COMPATIBILITY (164→187) and guarded by
-- isSchemaAlreadyApplied(case "187") → patty_settlement_outbox.

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
