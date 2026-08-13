import { NextResponse } from "next/server";
import { queryAuditEntries } from "@omniroute/open-sse/mcp-server/audit";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { parseIntegerWithFallback, parseOptionalBoolean } from "@/shared/utils/envParsing";

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseIntegerWithFallback(searchParams.get("limit"), 50);
    const offset = parseIntegerWithFallback(searchParams.get("offset"), 0);
    const tool = searchParams.get("tool") || undefined;
    const success = parseOptionalBoolean(searchParams.get("success"));
    const apiKeyId = searchParams.get("apiKeyId") || undefined;

    const result = await queryAuditEntries({
      limit,
      offset,
      tool,
      success,
      apiKeyId,
    });

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load MCP audit log";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
