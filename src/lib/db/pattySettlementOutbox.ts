import { getDbInstance } from "./core";
import type { PattyTerminalUsage } from "@omniroute/open-sse/services/pattyGateway.ts";

const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_REPLAY_LIMIT = 50;
const DEFAULT_BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 5 * 60_000;

export type DurablePattyTerminalUsage = Omit<
  PattyTerminalUsage,
  "requestMaterial" | "responseMaterial"
>;

export interface PattySettlementRecord {
  requestId: string;
  turnId: string;
  preflightRef: string;
  routeTarget: string;
  terminalUsage: DurablePattyTerminalUsage;
}

export interface PattySettlementOutboxRow {
  requestId: string;
  turnId: string;
  preflightRef: string;
  routeTarget: string;
  terminalUsageJson: string;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  updatedAt: number;
}

type StoredRow = {
  request_id: string;
  turn_id: string;
  preflight_ref: string;
  route_target: string;
  terminal_usage_json: string;
  attempts: number;
  next_attempt_at: number;
  created_at: number;
  updated_at: number;
};

type ReplayOptions = {
  now?: number;
  maxAttempts?: number;
  limit?: number;
  baseDelayMs?: number;
};

const TERMINAL_USAGE_KEYS = [
  "provider",
  "connection",
  "model",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "status",
  "errorCode",
  "latencyMs",
] as const;

function durableTerminalUsage(usage: DurablePattyTerminalUsage): DurablePattyTerminalUsage {
  const result: Record<string, unknown> = {};
  const source = usage as Record<string, unknown>;
  for (const key of TERMINAL_USAGE_KEYS) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result as DurablePattyTerminalUsage;
}

function mapRow(row: StoredRow): PattySettlementOutboxRow {
  return {
    requestId: row.request_id,
    turnId: row.turn_id,
    preflightRef: row.preflight_ref,
    routeTarget: row.route_target,
    terminalUsageJson: row.terminal_usage_json,
    attempts: Number(row.attempts),
    nextAttemptAt: Number(row.next_attempt_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function enqueuePattySettlement(
  record: PattySettlementRecord,
  { now = Date.now() }: { now?: number } = {}
): boolean {
  const result = getDbInstance()
    .prepare(
      `INSERT OR IGNORE INTO patty_settlement_outbox (
         request_id, turn_id, preflight_ref, route_target, terminal_usage_json,
         attempts, next_attempt_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`
    )
    .run(
      record.requestId,
      record.turnId,
      record.preflightRef,
      record.routeTarget,
      JSON.stringify(durableTerminalUsage(record.terminalUsage)),
      now,
      now,
      now
    );
  return result.changes > 0;
}

export function ackPattySettlement(requestId: string, turnId: string): boolean {
  const result = getDbInstance()
    .prepare("DELETE FROM patty_settlement_outbox WHERE request_id = ? AND turn_id = ?")
    .run(requestId, turnId);
  return result.changes > 0;
}

export function getPendingPattySettlements({
  now = Date.now(),
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  limit = DEFAULT_REPLAY_LIMIT,
  includeFuture = false,
}: ReplayOptions & { includeFuture?: boolean } = {}): PattySettlementOutboxRow[] {
  const dueClause = includeFuture ? "" : "AND next_attempt_at <= ?";
  const params = includeFuture ? [maxAttempts, limit] : [maxAttempts, now, limit];
  const rows = getDbInstance()
    .prepare(
      `SELECT request_id, turn_id, preflight_ref, route_target, terminal_usage_json,
              attempts, next_attempt_at, created_at, updated_at
         FROM patty_settlement_outbox
        WHERE attempts < ? ${dueClause}
        ORDER BY next_attempt_at ASC, created_at ASC
        LIMIT ?`
    )
    .all(...params) as StoredRow[];
  return rows.map(mapRow);
}

function recordFailedAttempt(
  row: PattySettlementOutboxRow,
  now: number,
  baseDelayMs: number
): void {
  const attempts = row.attempts + 1;
  const delayMs = Math.min(MAX_DELAY_MS, baseDelayMs * 2 ** row.attempts);
  getDbInstance()
    .prepare(
      `UPDATE patty_settlement_outbox
          SET attempts = ?, next_attempt_at = ?, updated_at = ?
        WHERE request_id = ? AND turn_id = ?`
    )
    .run(attempts, now + delayMs, now, row.requestId, row.turnId);
}

export async function replayPattySettlements(
  settle: (record: PattySettlementRecord) => Promise<void>,
  {
    now = Date.now(),
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    limit = DEFAULT_REPLAY_LIMIT,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
  }: ReplayOptions = {}
): Promise<{ attempted: number; acknowledged: number; failed: number }> {
  const rows = getPendingPattySettlements({ now, maxAttempts, limit });
  let acknowledged = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const terminalUsage = JSON.parse(row.terminalUsageJson) as DurablePattyTerminalUsage;
      await settle({
        requestId: row.requestId,
        turnId: row.turnId,
        preflightRef: row.preflightRef,
        routeTarget: row.routeTarget,
        terminalUsage,
      });
      ackPattySettlement(row.requestId, row.turnId);
      acknowledged += 1;
    } catch {
      recordFailedAttempt(row, now, baseDelayMs);
      failed += 1;
    }
  }

  return { attempted: rows.length, acknowledged, failed };
}
