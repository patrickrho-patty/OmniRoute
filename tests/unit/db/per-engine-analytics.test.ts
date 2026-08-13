/**
 * TDD: getPerEngineAnalytics — per-engine aggregation from compression_analytics.
 *
 * DB isolation pattern mirrors tests/unit/db/api-keys.test.ts:
 * - Temp DATA_DIR, resetDbInstance() before/after, close in test.after().
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ─── isolated temp DB ─────────────────────────────────────────────────────────

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-per-engine-analytics-"));
const originalDataDir = process.env.DATA_DIR;

process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
core.resetDbInstance();

const {
  insertCompressionAnalyticsRow,
  getPerEngineAnalytics,
  insertCompressionEngineBreakdown,
  getEngineRunHistory,
} = await import("../../../src/lib/db/compressionAnalytics.ts");

// ─── helpers ──────────────────────────────────────────────────────────────────

function resetDb(): void {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

// ─── lifecycle ────────────────────────────────────────────────────────────────

test.beforeEach(() => {
  resetDb();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

// ─── tests ────────────────────────────────────────────────────────────────────

test("getPerEngineAnalytics returns runs=0 and zeroed metrics for unknown engine", () => {
  const result = getPerEngineAnalytics("unknown-engine");
  assert.equal(result.engineId, "unknown-engine");
  assert.equal(result.runs, 0);
  assert.equal(result.tokensSaved, 0);
  assert.equal(result.avgSavingsPercent, 0);
  assert.equal(result.days, 7);
});

test("getPerEngineAnalytics returns correct aggregation for headroom rows only", () => {
  const now = new Date().toISOString();

  // 2 headroom rows: original=1000/compressed=800/saved=200 and original=500/compressed=350/saved=150
  insertCompressionAnalyticsRow({
    timestamp: now,
    mode: "stacked",
    engine: "headroom",
    original_tokens: 1000,
    compressed_tokens: 800,
    tokens_saved: 200,
  });
  insertCompressionAnalyticsRow({
    timestamp: now,
    mode: "stacked",
    engine: "headroom",
    original_tokens: 500,
    compressed_tokens: 350,
    tokens_saved: 150,
  });

  // 1 caveman row that must NOT appear in headroom results
  insertCompressionAnalyticsRow({
    timestamp: now,
    mode: "stacked",
    engine: "caveman",
    original_tokens: 800,
    compressed_tokens: 600,
    tokens_saved: 200,
  });

  const result = getPerEngineAnalytics("headroom");

  assert.equal(result.engineId, "headroom");
  assert.equal(result.runs, 2, "should count only the 2 headroom rows");
  assert.equal(result.tokensSaved, 350, "should sum tokens_saved for headroom rows");

  // avgSavingsPercent = round(((1500 - 1150) / 1500) * 1000) / 10
  //                   = round((350/1500) * 1000) / 10
  //                   = round(233.33...) / 10
  //                   = 233 / 10 = 23.3
  assert.equal(result.avgSavingsPercent, 23.3, `expected 23.3%, got ${result.avgSavingsPercent}`);
  assert.equal(result.days, 7);
});

test("getPerEngineAnalytics excludes rows outside the days window", () => {
  const recent = new Date().toISOString();
  // 30 days ago — outside the default 7-day window
  const old = new Date(Date.now() - 30 * 86400_000).toISOString();

  insertCompressionAnalyticsRow({
    timestamp: recent,
    mode: "stacked",
    engine: "headroom",
    original_tokens: 1000,
    compressed_tokens: 800,
    tokens_saved: 200,
  });
  insertCompressionAnalyticsRow({
    timestamp: old,
    mode: "stacked",
    engine: "headroom",
    original_tokens: 2000,
    compressed_tokens: 1000,
    tokens_saved: 1000,
  });

  const result = getPerEngineAnalytics("headroom", 7);
  assert.equal(result.runs, 1, "should only count the recent row within 7 days");
  assert.equal(result.tokensSaved, 200);
});

test("getPerEngineAnalytics falls back to mode column when engine is null (COALESCE behaviour)", () => {
  const now = new Date().toISOString();

  // Insert a row where engine is explicitly omitted — insertCompressionAnalyticsRow
  // writes engine = row.engine ?? row.mode, so we cannot get NULL via the helper.
  // Instead, insert raw via the DB to simulate a pre-engine row.
  const db = core.getDbInstance();
  db.prepare(
    `INSERT INTO compression_analytics (timestamp, mode, engine, original_tokens, compressed_tokens, tokens_saved)
     VALUES (?, ?, NULL, ?, ?, ?)`
  ).run(now, "caveman", 600, 400, 200);

  // COALESCE(engine, mode) = 'caveman' for the row above
  const result = getPerEngineAnalytics("caveman");
  assert.equal(result.runs, 1, "COALESCE fallback should match engine=NULL, mode=caveman");
  assert.equal(result.tokensSaved, 200);
});

test("getPerEngineAnalytics accepts custom days parameter", () => {
  const result = getPerEngineAnalytics("headroom", 30);
  assert.equal(result.days, 30);
});

// ─── getEngineRunHistory (Ponytail dashboard) ──────────────────────────────────

test("getEngineRunHistory returns [] for an engine with no breakdown rows", () => {
  assert.deepEqual(getEngineRunHistory("ponytail"), []);
});

test("getEngineRunHistory returns only the engine's rows, newest-first, in augmentation shape", () => {
  insertCompressionEngineBreakdown([
    {
      timestamp: "2026-06-28T00:00:01.000Z",
      request_id: "req-1",
      engine: "ponytail",
      original_tokens: 100,
      compressed_tokens: 100,
      tokens_saved: 0,
      duration_ms: null,
    },
    {
      timestamp: "2026-06-28T00:00:02.000Z",
      request_id: "req-2",
      engine: "ponytail",
      original_tokens: 200,
      compressed_tokens: 200,
      tokens_saved: 0,
      duration_ms: 5,
    },
    // a caveman row that must NOT appear in ponytail history
    {
      timestamp: "2026-06-28T00:00:03.000Z",
      request_id: "req-x",
      engine: "caveman",
      original_tokens: 900,
      compressed_tokens: 700,
      tokens_saved: 200,
      duration_ms: 9,
    },
  ]);

  const rows = getEngineRunHistory("ponytail");
  assert.equal(rows.length, 2, "only ponytail rows; caveman excluded");
  // newest-first (id DESC → last-inserted ponytail row first)
  assert.equal(rows[0].requestId, "req-2");
  assert.equal(rows[1].requestId, "req-1");
  // camelCase mapping + augmentation invariant (compressed === original, saved === 0)
  for (const r of rows) {
    assert.equal(r.compressedTokens, r.originalTokens);
    assert.equal(r.tokensSaved, 0);
  }
  assert.equal(rows[0].durationMs, 5);
  assert.equal(rows[1].durationMs, null);
});

test("getEngineRunHistory respects the limit", () => {
  insertCompressionEngineBreakdown(
    Array.from({ length: 5 }, (_, i) => ({
      timestamp: `2026-06-28T00:00:0${i}.000Z`,
      request_id: `req-${i}`,
      engine: "ponytail",
      original_tokens: 100,
      compressed_tokens: 100,
      tokens_saved: 0,
      duration_ms: null,
    }))
  );
  assert.equal(getEngineRunHistory("ponytail", 3).length, 3);
});
