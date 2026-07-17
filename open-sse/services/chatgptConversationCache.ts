export interface ChatGptConversationContext {
  conversationId: string;
  parentMessageId: string;
  toolFingerprint?: string;
  systemContext?: string;
}

interface CacheEntry extends ChatGptConversationContext {
  expiresAt: number;
}

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_ENTRY_BYTES = 64 * 1024;
// NOTE: TTL+LRU+byte-bounding here resembles chatgptImageCache.ts and
// src/lib/cacheLayer.ts's LRUCache, but neither of those provides the
// compare-and-swap writes (`expected`) or the per-key async continuation lock
// this module needs, so it intentionally stays a standalone implementation.
const cache = new Map<string, CacheEntry>();
const continuationLocks = new Map<string, Promise<void>>();
let cacheBytes = 0;
let nextExpirySweepAt = 0;

function configuredTtlMs(): number {
  const value = Number(process.env.OMNIROUTE_CGPT_WEB_CONVERSATION_TTL_MS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_TTL_MS;
}

function configuredMaxEntries(): number {
  const value = Number(process.env.OMNIROUTE_CGPT_WEB_CONVERSATION_MAX_ENTRIES);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_ENTRIES;
}

function configuredMaxBytes(): number {
  const value = Number(process.env.OMNIROUTE_CGPT_WEB_CONVERSATION_MAX_BYTES);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_BYTES;
}

function configuredMaxEntryBytes(): number {
  const value = Number(process.env.OMNIROUTE_CGPT_WEB_CONVERSATION_MAX_ENTRY_BYTES);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_ENTRY_BYTES;
}

function entryBytes(entry: ChatGptConversationContext): number {
  return Buffer.byteLength(
    `${entry.conversationId}${entry.parentMessageId}${entry.toolFingerprint ?? ""}${entry.systemContext ?? ""}`
  );
}

function deleteEntry(key: string): void {
  const entry = cache.get(key);
  if (!entry) return;
  cacheBytes -= entryBytes(entry);
  cache.delete(key);
}

function evictExpired(now = Date.now()): void {
  if (now < nextExpirySweepAt) return;
  for (const [key, entry] of cache) {
    if (now >= entry.expiresAt) deleteEntry(key);
  }
  nextExpirySweepAt = now + 60_000;
}

function evictOldest(incomingBytes: number): void {
  const maxEntries = configuredMaxEntries();
  const maxBytes = configuredMaxBytes();
  while ((cache.size >= maxEntries || cacheBytes + incomingBytes > maxBytes) && cache.size > 0) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) break;
    deleteEntry(oldestKey);
  }
}

export function getChatGptConversationContext(key: string): ChatGptConversationContext | null {
  evictExpired();
  const entry = cache.get(key);
  if (!entry) return null;

  if (Date.now() >= entry.expiresAt) {
    deleteEntry(key);
    return null;
  }

  cache.delete(key);
  cache.set(key, entry);
  return {
    conversationId: entry.conversationId,
    parentMessageId: entry.parentMessageId,
    toolFingerprint: entry.toolFingerprint,
    systemContext: entry.systemContext,
  };
}

function matchesContext(
  entry: ChatGptConversationContext | undefined,
  expected: ChatGptConversationContext
): boolean {
  return (
    entry?.conversationId === expected.conversationId &&
    entry.parentMessageId === expected.parentMessageId
  );
}

export function setChatGptConversationContext(
  key: string,
  context: ChatGptConversationContext,
  expected: ChatGptConversationContext | null = null
): boolean {
  evictExpired();
  const bytes = entryBytes(context);
  if (bytes > configuredMaxEntryBytes() || bytes > configuredMaxBytes()) return false;
  const current = cache.get(key);
  if (expected ? !matchesContext(current, expected) : current !== undefined) return false;

  deleteEntry(key);
  evictOldest(bytes);
  cache.set(key, {
    ...context,
    expiresAt: Date.now() + configuredTtlMs(),
  });
  cacheBytes += bytes;
  return true;
}

export function deleteChatGptConversationContext(
  key: string,
  expected?: ChatGptConversationContext
): boolean {
  const current = cache.get(key);
  if (expected && !matchesContext(current, expected)) return false;
  if (!current) return false;
  deleteEntry(key);
  return true;
}

/**
 * Serialize a full continuation turn for one trusted cache key. The caller's
 * operation owns the lock until its upstream turn has either recorded the next
 * parent message or failed, preventing two requests from posting from one
 * cached parent concurrently.
 */
export async function acquireChatGptConversationLock(key: string): Promise<() => void> {
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = continuationLocks.get(key) ?? Promise.resolve();
  const queued = current.then(() => next);
  continuationLocks.set(key, queued);

  await current;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
    if (continuationLocks.get(key) === queued) continuationLocks.delete(key);
  };
}

export function __resetChatGptConversationCacheForTesting(): void {
  cache.clear();
  continuationLocks.clear();
  cacheBytes = 0;
  nextExpirySweepAt = 0;
}

export function __getChatGptConversationCacheBytesForTesting(): number {
  return cacheBytes;
}
