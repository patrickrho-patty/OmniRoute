/**
 * GET /api/analytics/compression
 *
 * Returns aggregated compression analytics from the compression_analytics table.
 * Supports ?since=24h|7d|30d|all (default: 24h).
 *
 * When ?engine=<id> is supplied, returns a per-engine view instead — the engine
 * aggregate plus recent run history from compression_engine_breakdown — for the
 * per-engine dashboards (e.g. Ponytail). ?limit=<n> bounds the history (default 50).
 */

import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
import {
  getCompressionAnalyticsSummary,
  getPerEngineAnalytics,
  getEngineRunHistory,
} from "@/lib/db/compressionAnalytics";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";

const SINCE_TO_DAYS: Record<string, number> = { "24h": 1, "7d": 7, "30d": 30, all: 3650 };

export async function GET(req: Request) {
  const authError = await requireManagementAuth(req);
  if (authError) return authError;

  try {
    const url = new URL(req.url);
    const sinceParam = url.searchParams.get("since") ?? "24h";
    const validSince = ["24h", "7d", "30d", "all"].includes(sinceParam) ? sinceParam : "24h";

    const engineParam = url.searchParams.get("engine");
    if (engineParam) {
      const engine = engineParam.trim().toLowerCase().slice(0, 64);
      const days = SINCE_TO_DAYS[validSince] ?? 1;
      const limitRaw = Number(url.searchParams.get("limit"));
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 50;
      return NextResponse.json({
        engine,
        since: validSince,
        aggregate: getPerEngineAnalytics(engine, days),
        history: getEngineRunHistory(engine, limit),
      });
    }

    const summary = getCompressionAnalyticsSummary(validSince === "all" ? undefined : validSince);

    return NextResponse.json(summary);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[/api/analytics/compression]", msg);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
