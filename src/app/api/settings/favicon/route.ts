import { NextRequest, NextResponse } from "next/server";
import { getSettings } from "@/lib/db/settings";
import { SAFE_OUTBOUND_FETCH_PRESETS, safeOutboundFetch } from "@/shared/network/safeOutboundFetch";
import { normalizeBasePath } from "@/shared/utils/basePath";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";

const ALLOWED_IMAGE_TYPES = [
  "image/png",
  "image/x-icon",
  "image/svg+xml",
  "image/gif",
  "image/webp",
  "image/jpeg",
];
const MAX_FAVICON_SIZE = 50 * 1024; // 50KB
const FETCH_TIMEOUT = 5000; // 5 seconds
const CACHE_DURATION = 300; // 5 minutes
// Fork brand asset: the Patty checkout ships `public/favicon.ico` and no SVG icon
// file, so the default-icon fallback must point at the file that actually exists on
// this tree — see tests/unit/patty-brand-assets.test.ts.
const DEFAULT_ICON_FILENAME = "favicon.ico";
const DEFAULT_ICON_CONTENT_TYPE = "image/x-icon";

function validateImageData(base64Data: string, contentType: string): boolean {
  if (!ALLOWED_IMAGE_TYPES.includes(contentType)) {
    console.error("Invalid content type:", contentType);
    return false;
  }
  // Check for obvious image magic bytes
  const matches = base64Data.match(/^data:[^;]+;base64,(.+)$/);
  if (!matches) return false;

  const binaryData = Buffer.from(matches[1], "base64");
  if (binaryData.length > MAX_FAVICON_SIZE) {
    console.error("Favicon too large:", binaryData.length);
    return false;
  }

  return true;
}

/**
 * Fork API: absolute same-origin redirect to the bundled default icon, basePath aware.
 * Kept synchronous (`NextResponse`) — the Patty brand-asset test calls it directly.
 */
export function defaultFaviconRedirect(request: Request): NextResponse {
  const { origin, target } = resolveDefaultIconTarget(request as NextRequest);
  return NextResponse.redirect(new URL(target, origin));
}

export async function GET(request: NextRequest) {
  try {
    const settings = await getSettings();

    const customFaviconBase64 = settings?.customFaviconBase64 as string | undefined;
    const customFaviconUrl = settings?.customFaviconUrl as string | undefined;

    let faviconData: string | null = null;

    if (customFaviconBase64) {
      // Validate stored Base64 data
      const match = customFaviconBase64.match(/^data:([^;]+);base64,(.+)$/);
      if (match && validateImageData(customFaviconBase64, match[1])) {
        faviconData = customFaviconBase64;
      }
    } else if (customFaviconUrl) {
      try {
        const response = await safeOutboundFetch(customFaviconUrl, {
          ...SAFE_OUTBOUND_FETCH_PRESETS.validationRead,
          guard: "public-only",
          timeoutMs: FETCH_TIMEOUT,
          headers: {
            "User-Agent": "OmniRoute/2.0",
          },
        });

        if (response.ok) {
          const contentType = response.headers.get("content-type") || "";
          const arrayBuffer = await response.arrayBuffer();
          const uint8Array = new Uint8Array(arrayBuffer);

          // Validate size before processing
          if (uint8Array.length > MAX_FAVICON_SIZE) {
            console.error("Favicon exceeds max size:", uint8Array.length);
          } else {
            const base64 = Buffer.from(uint8Array).toString("base64");
            const fullData = `data:${contentType};base64,${base64}`;

            if (validateImageData(fullData, contentType)) {
              faviconData = fullData;
            }
          }
        }
      } catch (error) {
        console.error("Failed to fetch custom favicon:", error);
      }
    }

    if (!faviconData) {
      return buildDefaultIconRedirect(request);
    }

    const match = faviconData.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      return buildDefaultIconRedirect(request);
    }

    const contentType = match[1];
    const base64Data = match[2];
    const buffer = Buffer.from(base64Data, "base64");

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": `public, max-age=${CACHE_DURATION}`,
      },
    });
  } catch (error) {
    console.error("Favicon API error:", error);
    return buildDefaultIconRedirect(request);
  }
}

function firstHeaderValue(value: string | null): string {
  return (value ?? "").split(",")[0].trim();
}

function resolveRequestScheme(request: NextRequest, rawProto: string): string {
  if (rawProto === "http" || rawProto === "https") return rawProto;
  return new URL(request.url).protocol === "https:" ? "https" : "http";
}

function resolveDefaultIconTarget(request: NextRequest): { origin: string; target: string } {
  const headers = request.headers;
  // Fork: a bare `Request` (direct caller / unit test) carries no Host header — fall back to
  // the request URL's own host so the redirect stays an absolute same-origin URL.
  const host =
    firstHeaderValue(headers.get("x-forwarded-host")) ||
    firstHeaderValue(headers.get("host")) ||
    new URL(request.url).host;
  const scheme = resolveRequestScheme(
    request,
    firstHeaderValue(headers.get("x-forwarded-proto")).toLowerCase()
  );
  const basePath = request.nextUrl?.basePath || normalizeBasePath(process.env.OMNIROUTE_BASE_PATH);
  if (!host) throw new Error("missing request origin");
  return {
    origin: `${scheme}://${host}`,
    target: `${basePath}/${DEFAULT_ICON_FILENAME}`,
  };
}

function buildDefaultIconRedirect(request?: NextRequest): Promise<NextResponse> | NextResponse {
  try {
    if (!request) throw new Error("missing request origin");
    return defaultFaviconRedirect(request);
  } catch {
    return serveDefaultIconFile();
  }
}

async function serveDefaultIconFile(): Promise<NextResponse> {
  try {
    const filePath = path.join(process.cwd(), "public", DEFAULT_ICON_FILENAME);
    const body = await readFile(filePath);
    return new NextResponse(body, {
      headers: { "Content-Type": DEFAULT_ICON_CONTENT_TYPE },
    });
  } catch (error) {
    console.error("Favicon API error:", error);
    return new NextResponse("Not found", { status: 404 });
  }
}
