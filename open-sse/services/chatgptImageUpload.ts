/**
 * ChatGPT Web inbound-image upload.
 *
 * Replicates exactly what chatgpt.com's browser client does when a user drags
 * an image into the composer, so images the client sends (OpenAI `image_url`
 * content parts) are actually SEEN by GPT — instead of being silently dropped
 * by the text-only message flattener in chatgpt-web.ts.
 *
 * Browser protocol (verified against the live web client / chat2api reference):
 *   1. POST /backend-api/files
 *        { file_name, file_size, use_case:"multimodal", reset_rate_limits:false,
 *          timezone_offset_min }
 *      → { file_id, upload_url }
 *   2. PUT <upload_url>  (Azure blob signed URL — NOT chatgpt.com)
 *        raw bytes, headers: x-ms-blob-type:BlockBlob, x-ms-version, content-type,
 *        NO Authorization  → 201 Created
 *   3. POST /backend-api/files/{file_id}/uploaded  {}   → finalize
 *   4. Reference the file in the conversation message as an
 *        image_asset_pointer part (asset_pointer "file-service://{file_id}")
 *        plus a metadata.attachments entry.
 *
 * The two chatgpt.com calls (steps 1 & 3) go through the TLS-fingerprinted
 * client with full browser auth headers. Step 2 targets Azure blob storage and
 * uses a plain fetch with the auth header stripped (exactly as the browser does).
 */
import { randomUUID } from "node:crypto";
import { fetchRemoteImage } from "@/shared/network/remoteImageFetch";
import { tlsFetchChatGpt } from "./chatgptTlsClient.ts";

const CHATGPT_BASE = "https://chatgpt.com";
const FILES_URL = `${CHATGPT_BASE}/backend-api/files`;

// ChatGPT rejects oversize attachments; the web client caps image uploads well
// under this. Skip anything larger so we never waste a slow upload on a file
// the server will reject anyway.
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB per image
const MAX_TOTAL_IMAGE_BYTES = 40 * 1024 * 1024; // 40 MB aggregate per turn
const MAX_IMAGES_PER_TURN = 4;
const IMAGE_FETCH_TIMEOUT_MS = 15_000;
const IMAGE_UPLOAD_CONCURRENCY = 2;
// Azure blob PUT can hang; bound it independently of the chatgpt.com calls.
const BLOB_PUT_TIMEOUT_MS = 30_000;

export interface UploadedChatGptImage {
  fileId: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  width: number;
  height: number;
}

export interface ChatGptUploadAuthContext {
  accessToken: string;
  accountId: string | null;
  sessionId: string;
  deviceId: string;
  /** Browser/OAI header set to attach to chatgpt.com backend-api calls. */
  baseHeaders: Record<string, string>;
  signal?: AbortSignal;
  log?: {
    debug?: (tag: string, msg: string) => void;
    info?: (tag: string, msg: string) => void;
    warn?: (tag: string, msg: string) => void;
    error?: (tag: string, msg: string) => void;
  } | null;
}

interface RawImage {
  bytes: Buffer;
  mime: string;
}

/**
 * Pull inbound `image_url` parts out of the CURRENT user turn (the last user
 * message). Prior-turn images live in folded history text and are not
 * re-uploaded — only the active turn's images become a multimodal message.
 *
 * Returns the ordered list of image URLs (data: or http(s):).
 */
export function extractCurrentTurnImageUrls(messages: Array<Record<string, unknown>>): string[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (String(msg?.role || "") !== "user") continue;
    const content = msg.content;
    if (!Array.isArray(content)) return [];
    const urls: string[] = [];
    for (const part of content as Array<Record<string, unknown>>) {
      if (!part || typeof part !== "object") continue;
      // OpenAI chat format: { type:"image_url", image_url:{ url } }
      if (part.type === "image_url") {
        const iu = part.image_url as Record<string, unknown> | string | undefined;
        const url = typeof iu === "string" ? iu : (iu?.url as string | undefined);
        if (typeof url === "string" && url.trim()) urls.push(url.trim());
      }
      // Responses / Anthropic-ish format: { type:"input_image", image_url }
      else if (part.type === "input_image") {
        const url =
          typeof part.image_url === "string"
            ? part.image_url
            : ((part.image_url as Record<string, unknown>)?.url as string | undefined);
        if (typeof url === "string" && url.trim()) urls.push(url.trim());
      }
    }
    return urls;
  }
  return [];
}

function describeImageSource(url: string): string {
  if (url.startsWith("data:")) {
    const commaIdx = url.indexOf(",");
    const header = commaIdx >= 0 ? url.slice(5, commaIdx) : url.slice(5);
    return `data:${(header.split(";")[0] || "unknown").slice(0, 64)};<redacted>`;
  }
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}${parsed.pathname || "/"}`.slice(0, 160);
  } catch {
    return "<invalid image url>";
  }
}

function sniffImageMime(bytes: Buffer): string | null {
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 10 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 30 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function decodeDataImageUrl(url: string): RawImage | null {
  const commaIdx = url.indexOf(",");
  if (commaIdx < 0) return null;
  const header = url.slice(5, commaIdx); // strip "data:"
  const declaredMime = (header.split(";")[0] || "").trim().toLowerCase();
  if (!declaredMime.startsWith("image/")) return null;
  if (!/;base64/i.test(header)) return null;

  const payload = url.slice(commaIdx + 1);
  if (payload.length > MAX_IMAGE_BYTES * 2) return null;
  const normalized = payload.replace(/\s/g, "");
  if (Math.floor((normalized.length * 3) / 4) > MAX_IMAGE_BYTES) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) return null;

  const bytes = Buffer.from(normalized, "base64");
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
  const sniffedMime = sniffImageMime(bytes);
  if (!sniffedMime) return null;
  return { bytes, mime: sniffedMime };
}

/** Fetch image bytes + mime from a data: URL or a SSRF-guarded http(s) URL. */
async function fetchImageBytes(url: string, signal?: AbortSignal): Promise<RawImage | null> {
  if (url.startsWith("data:")) {
    return decodeDataImageUrl(url);
  }
  try {
    const remote = await fetchRemoteImage(url, {
      guard: "public-only",
      maxBytes: MAX_IMAGE_BYTES,
      timeoutMs: IMAGE_FETCH_TIMEOUT_MS,
      signal,
    });
    const declaredMime = remote.contentType.split(";")[0].trim().toLowerCase();
    if (!declaredMime.startsWith("image/")) return null;
    const sniffedMime = sniffImageMime(remote.buffer);
    if (!sniffedMime) return null;
    return { bytes: remote.buffer, mime: sniffedMime };
  } catch {
    return null;
  }
}

/**
 * Read pixel dimensions from image bytes for PNG / JPEG / GIF / WebP.
 * Returns null if the format isn't recognized (caller falls back to a default).
 */
export function readImageDimensions(bytes: Buffer): { width: number; height: number } | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A, IHDR width@16 height@20 (uint32 BE)
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  // GIF: "GIF8", width@6 height@8 (uint16 LE)
  if (
    bytes.length >= 10 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  // JPEG: FF D8, scan for SOF markers (FF C0..CF, excluding C4/C8/CC)
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let off = 2;
    while (off + 8 < bytes.length) {
      if (bytes[off] !== 0xff) {
        off++;
        continue;
      }
      const marker = bytes[off + 1];
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        const height = bytes.readUInt16BE(off + 5);
        const width = bytes.readUInt16BE(off + 7);
        return { width, height };
      }
      const segLen = bytes.readUInt16BE(off + 2);
      if (segLen < 2) break;
      off += 2 + segLen;
    }
  }
  // WebP: "RIFF"...."WEBP"
  if (
    bytes.length >= 30 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    const fmt = bytes.toString("ascii", 12, 16);
    if (fmt === "VP8 ") {
      // Lossy: dimensions at offset 26 (14-bit each, LE)
      const width = bytes.readUInt16LE(26) & 0x3fff;
      const height = bytes.readUInt16LE(28) & 0x3fff;
      return { width, height };
    }
    if (fmt === "VP8L") {
      // Lossless: 14-bit dims packed after 1-byte signature at offset 21
      const b0 = bytes[21];
      const b1 = bytes[22];
      const b2 = bytes[23];
      const b3 = bytes[24];
      const width = 1 + (((b1 & 0x3f) << 8) | b0);
      const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      return { width, height };
    }
    if (fmt === "VP8X") {
      // Extended: 24-bit canvas dims at offset 24 (minus 1), LE
      const width = 1 + ((bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) & 0xffffff);
      const height = 1 + ((bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) & 0xffffff);
      return { width, height };
    }
  }
  return null;
}

function extensionForMime(mime: string): string {
  switch (mime) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    default:
      return ".png";
  }
}

function chatGptHeaders(ctx: ChatGptUploadAuthContext): Record<string, string> {
  const headers: Record<string, string> = {
    ...ctx.baseHeaders,
    "Content-Type": "application/json",
    Accept: "*/*",
    Authorization: `Bearer ${ctx.accessToken}`,
  };
  if (ctx.accountId) headers["chatgpt-account-id"] = ctx.accountId;
  return headers;
}

/** Step 1: request a file slot + Azure upload URL. */
async function requestUploadSlot(
  fileName: string,
  fileSize: number,
  ctx: ChatGptUploadAuthContext
): Promise<{ fileId: string; uploadUrl: string } | null> {
  const res = await tlsFetchChatGpt(FILES_URL, {
    method: "POST",
    headers: chatGptHeaders(ctx),
    body: JSON.stringify({
      file_name: fileName,
      file_size: fileSize,
      use_case: "multimodal",
      reset_rate_limits: false,
      timezone_offset_min: -new Date().getTimezoneOffset(),
    }),
    timeoutMs: 15_000,
    signal: ctx.signal,
  });
  if (res.status !== 200) {
    ctx.log?.warn?.(
      "CGPT-WEB",
      `image upload slot failed ${res.status}: ${(res.text || "").slice(0, 200)}`
    );
    return null;
  }
  try {
    const json = JSON.parse(res.text || "{}");
    if (json.file_id && json.upload_url) {
      return { fileId: json.file_id, uploadUrl: json.upload_url };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Step 2: PUT the bytes to the Azure blob signed URL (plain fetch, no auth). */
async function putBytes(
  uploadUrl: string,
  bytes: Buffer,
  mime: string,
  ctx: ChatGptUploadAuthContext
): Promise<boolean> {
  // Bound the blob PUT with its own timeout, combined with any caller abort.
  const signals: AbortSignal[] = [AbortSignal.timeout(BLOB_PUT_TIMEOUT_MS)];
  if (ctx.signal) signals.push(ctx.signal);
  const signal = AbortSignal.any(signals);
  try {
    const resp = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": mime,
        "x-ms-blob-type": "BlockBlob",
        "x-ms-version": "2020-04-08",
      },
      body: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      signal,
    });
    if (resp.status === 200 || resp.status === 201) return true;
    ctx.log?.warn?.("CGPT-WEB", `image blob PUT failed ${resp.status}`);
    return false;
  } catch (err) {
    ctx.log?.warn?.(
      "CGPT-WEB",
      `image blob PUT error: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}

/** Step 3: finalize the upload so ChatGPT registers the file. */
async function finalizeUpload(fileId: string, ctx: ChatGptUploadAuthContext): Promise<boolean> {
  const res = await tlsFetchChatGpt(`${FILES_URL}/${encodeURIComponent(fileId)}/uploaded`, {
    method: "POST",
    headers: chatGptHeaders(ctx),
    body: JSON.stringify({}),
    timeoutMs: 15_000,
    signal: ctx.signal,
  });
  if (res.status !== 200) {
    ctx.log?.warn?.(
      "CGPT-WEB",
      `image upload finalize failed ${res.status}: ${(res.text || "").slice(0, 200)}`
    );
    return false;
  }
  return true;
}

/** Upload a single already-fetched image. Returns metadata or null on failure. */
async function uploadOne(
  raw: RawImage,
  ctx: ChatGptUploadAuthContext
): Promise<UploadedChatGptImage | null> {
  const mime = raw.mime.startsWith("image/") ? raw.mime : "image/png";
  const dims = readImageDimensions(raw.bytes) ?? { width: 1024, height: 1024 };
  const name = `${randomUUID()}${extensionForMime(mime)}`;
  const size = raw.bytes.length;

  const slot = await requestUploadSlot(name, size, ctx);
  if (!slot) return null;
  if (!(await putBytes(slot.uploadUrl, raw.bytes, mime, ctx))) return null;
  if (!(await finalizeUpload(slot.fileId, ctx))) return null;

  return {
    fileId: slot.fileId,
    name,
    sizeBytes: size,
    mimeType: mime,
    width: dims.width,
    height: dims.height,
  };
}

/**
 * Fetch + upload every image URL for the current turn. Failures are skipped
 * (best-effort) so a single bad image never breaks the whole request. Returns
 * the uploaded-file metadata in original order.
 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function uploadCurrentTurnImages(
  urls: string[],
  ctx: ChatGptUploadAuthContext
): Promise<UploadedChatGptImage[]> {
  if (urls.length === 0) return [];
  if (urls.length > MAX_IMAGES_PER_TURN) {
    ctx.log?.warn?.(
      "CGPT-WEB",
      `image upload rejected: ${urls.length} images exceeds cap ${MAX_IMAGES_PER_TURN}`
    );
    return [];
  }

  const fetchByUrl = new Map<string, Promise<RawImage | null>>();
  const getRaw = (url: string) => {
    let promise = fetchByUrl.get(url);
    if (!promise) {
      promise = (async () => {
        if (ctx.signal?.aborted) return null;
        const raw = await fetchImageBytes(url, ctx.signal);
        if (!raw) {
          ctx.log?.warn?.("CGPT-WEB", `image fetch failed for upload: ${describeImageSource(url)}`);
          return null;
        }
        if (raw.bytes.length === 0 || raw.bytes.length > MAX_IMAGE_BYTES) {
          ctx.log?.warn?.(
            "CGPT-WEB",
            `image skipped (size ${raw.bytes.length}b, cap ${MAX_IMAGE_BYTES}b): ${describeImageSource(url)}`
          );
          return null;
        }
        return raw;
      })();
      fetchByUrl.set(url, promise);
    }
    return promise;
  };

  const fetched = await mapLimit(urls, IMAGE_UPLOAD_CONCURRENCY, async (url) => ({
    url,
    raw: await getRaw(url),
  }));

  if (fetched.some((entry) => entry.raw === null)) return [];
  const rawImages = fetched as Array<{ url: string; raw: RawImage }>;
  const uniqueRawByUrl = new Map<string, RawImage>();
  for (const { url, raw } of rawImages) uniqueRawByUrl.set(url, raw);
  const totalBytes = [...uniqueRawByUrl.values()].reduce((sum, raw) => sum + raw.bytes.length, 0);
  if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
    ctx.log?.warn?.(
      "CGPT-WEB",
      `image upload rejected: total ${totalBytes}b exceeds cap ${MAX_TOTAL_IMAGE_BYTES}b`
    );
    return [];
  }

  const uploadByUrl = new Map<string, Promise<UploadedChatGptImage | null>>();
  const getUploaded = (url: string, raw: RawImage) => {
    let promise = uploadByUrl.get(url);
    if (!promise) {
      promise = (async () => {
        if (ctx.signal?.aborted) return null;
        const meta = await uploadOne(raw, ctx);
        if (meta) {
          ctx.log?.info?.(
            "CGPT-WEB",
            `image uploaded → file-service://${meta.fileId} (${meta.width}x${meta.height}, ${meta.sizeBytes}b)`
          );
        }
        return meta;
      })();
      uploadByUrl.set(url, promise);
    }
    return promise;
  };

  const uploaded = await mapLimit(rawImages, IMAGE_UPLOAD_CONCURRENCY, async ({ url, raw }) =>
    getUploaded(url, raw)
  );

  return uploaded.filter((meta): meta is UploadedChatGptImage => Boolean(meta));
}
