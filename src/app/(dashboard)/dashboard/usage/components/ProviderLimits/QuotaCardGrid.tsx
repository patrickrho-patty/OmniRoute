"use client";

/**
 * QuotaCardGrid — ONE unified MagicGrid board of quota cards.
 *
 * Every connection — any provider, any account count — renders as the same
 * fixed-width card and flows into the same grid (shortest-column-first), so
 * single-account providers sit right next to multi-account ones instead of
 * stretching across the whole row or hiding in a per-provider section.
 * Provider identity lives on the card itself (icon + label + plan badge).
 *
 * Layout engine: magic-grid (MagicGrid). Cards keep their CSS width
 * (`w-full` on phones → 1 column; `sm:w-[320px]` → as many 320px columns as
 * fit, capped by maxColumns). MagicGrid only computes positions; we drive
 * `positionItems()` from our own ResizeObserver / MutationObserver / window
 * resize listeners so every listener is disconnectable on unmount (the
 * library's `listen()` leaks a window listener and has no destroy).
 */

import { useEffect, useRef } from "react";
import MagicGrid from "magic-grid";
import QuotaCard from "./QuotaCard";
import {
  compareProviderGroups,
  worstStatus,
  type CardStatus,
  type QuotaVisibilityScope,
} from "./utils";
import { PROVIDER_ORDER } from "./constants";
import { compareTr } from "@/shared/utils/turkishText";

interface Props {
  connections: any[];
  quotaData: Record<string, any>;
  loading: Record<string, boolean>;
  errors: Record<string, string | null>;
  lastRefreshedAt: Record<string, string | undefined>;
  emailsVisible: boolean;
  providerLabels: Record<string, string>;
  renderInlineQuotaSummary?: (quota: any) => React.ReactNode;
  onRefresh: (id: string, provider: string) => void;
  onOpenCutoff: (connection: any) => void;
  onOpenResetCredits?: (id: string, provider: string) => void;
  onToggleActive: (id: string, nextActive: boolean) => void;
  togglingActiveId: string | null;
  redeemingResetCreditId?: string | null;
  loadingResetCreditsId?: string | null;
  /** Per-operator quota row visibility (upstream 9router#2371 port). */
  quotaVisibility?: Record<string, { hidden?: string[] }>;
  onHideQuota?: (scope: QuotaVisibilityScope, quota: any) => void;
  onShowQuota?: (scope: QuotaVisibilityScope, quota: any) => void;
  /** Compact home-widget density: narrower cards on the same board. */
  compact?: boolean;
}

const STATUS_RANK: Record<CardStatus, number> = {
  critical: 0,
  alert: 1,
  ok: 2,
  empty: 3,
};

function getSoonestResetMs(quotas: any[] | undefined): number {
  if (!Array.isArray(quotas) || quotas.length === 0) return Number.POSITIVE_INFINITY;
  const now = Date.now();
  let soonest = Number.POSITIVE_INFINITY;
  for (const quota of quotas) {
    if (!quota?.resetAt) continue;
    const ts = new Date(quota.resetAt).getTime();
    if (Number.isFinite(ts) && ts > now && ts < soonest) soonest = ts;
  }
  return soonest;
}

function getRemainingPercentage(quota: any): number {
  if (quota?.unlimited) return 100;
  if (typeof quota?.remainingPercentage === "number") return quota.remainingPercentage;
  if (typeof quota?.total === "number" && quota.total > 0) {
    const used = typeof quota.used === "number" ? quota.used : 0;
    return Math.max(0, Math.min(100, Math.round(((quota.total - used) / quota.total) * 100)));
  }
  return 100;
}

function getLowestRemainingPercentage(quotas: any[] | undefined): number {
  if (!Array.isArray(quotas) || quotas.length === 0) return 100;
  let lowest = 100;
  for (const quota of quotas) {
    lowest = Math.min(lowest, getRemainingPercentage(quota));
  }
  return lowest;
}

function hasUsableQuota(quotas: any[] | undefined): boolean {
  if (!Array.isArray(quotas) || quotas.length === 0) return true;
  return quotas.some((quota) => quota?.unlimited || getRemainingPercentage(quota) > 0);
}

function getConnectionLabel(connection: any): string {
  return String(
    connection.name || connection.displayName || connection.email || connection.id || ""
  );
}

export function sortProviderConnectionsByPriority(
  connections: any[],
  quotaData: Record<string, any>,
  providerLabels: Record<string, string> = {}
) {
  return [...connections].sort((a, b) => {
    // Providers grouped adjacently — same-provider cards must sit next to
    // each other on the unified board ("All providers" view scannability).
    const providerDiff = compareProviderGroups(a.provider, b.provider, {
      providerOrder: PROVIDER_ORDER,
      providerLabels,
      compare: compareTr,
    });
    if (providerDiff !== 0) return providerDiff;

    const aActive = a.isActive ?? true;
    const bActive = b.isActive ?? true;
    if (aActive !== bActive) return aActive ? -1 : 1;

    const aQuotas = quotaData[a.id]?.quotas;
    const bQuotas = quotaData[b.id]?.quotas;
    const aUsable = hasUsableQuota(aQuotas);
    const bUsable = hasUsableQuota(bQuotas);
    if (aUsable !== bUsable) return aUsable ? -1 : 1;

    const statusDiff = STATUS_RANK[worstStatus(aQuotas)] - STATUS_RANK[worstStatus(bQuotas)];
    if (statusDiff !== 0) return statusDiff;

    // Minute granularity: idle opencode 5h windows report resetsAt = now+5h,
    // so every card's reset differs only by seconds of fetch-order jitter —
    // comparing at full ms resolution reordered cards on every refresh (read
    // by operators as accounts "swapping usage"). A real sooner reset is
    // still >= a minute apart. Cards with NO future reset (Infinity on both
    // sides) must skip this tiebreak entirely: Infinity - Infinity is NaN,
    // and a NaN comparator return short-circuits the remaining% comparison
    // below with an engine-defined order (live bug: every idle opencode
    // card has resetAt null since the idle-window fix).
    const aReset = getSoonestResetMs(aQuotas);
    const bReset = getSoonestResetMs(bQuotas);
    if (Number.isFinite(aReset) && Number.isFinite(bReset)) {
      const resetDiff = Math.floor(aReset / 60_000) - Math.floor(bReset / 60_000);
      if (resetDiff !== 0) return resetDiff;
    }

    const remainingDiff =
      getLowestRemainingPercentage(aQuotas) - getLowestRemainingPercentage(bQuotas);
    if (remainingDiff !== 0) return remainingDiff;

    return getConnectionLabel(a).localeCompare(getConnectionLabel(b));
  });
}

/** Card width per density mode — phones go full-width (single MagicGrid column). */
const CARD_WIDTH_CLASS = {
  // 320px fits a full e-mail address on the account line; the header wraps its chips
  // (see QuotaCardHeader) rather than crushing the text when a card is narrower.
  full: "w-full sm:w-[320px]",
  compact: "w-full sm:w-[296px]",
} as const;

export default function QuotaCardGrid({
  connections,
  quotaData,
  loading,
  errors,
  lastRefreshedAt,
  emailsVisible,
  providerLabels,
  renderInlineQuotaSummary: _renderInlineQuotaSummary,
  onRefresh,
  onOpenCutoff,
  onOpenResetCredits,
  onToggleActive,
  togglingActiveId,
  redeemingResetCreditId = null,
  loadingResetCreditsId = null,
  quotaVisibility,
  onHideQuota,
  onShowQuota,
  compact = false,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const sorted = sortProviderConnectionsByPriority(connections, quotaData, providerLabels);

  // MagicGrid lifecycle: one instance per mount; `static: true` bypasses the
  // item-count gate so we can position partial loads, and we NEVER call
  // listen() (it registers an unremovable window resize listener). All
  // reposition triggers are ours and cleaned up below.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const grid = new MagicGrid({
      container,
      static: true,
      gutter: 12,
      // Row-major placement (round-robin columns): with cards grouped by
      // provider in DOM order, each row reads as consecutive provider blocks.
      // useMin's shortest-column-first packing would scatter them.
      useMin: false,
      // No column cap — the board uses all available width on wide screens.
      animate: true,
    });

    let frame = 0;
    const reposition = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        grid.positionItems();
      });
    };

    // Card heights change without React state changes: "Show 5 more"
    // expanders, loading → data swaps, refreshed countdown text.
    const mutation = new MutationObserver(reposition);
    mutation.observe(container, { childList: true, subtree: true, characterData: true });

    const resize = new ResizeObserver(reposition);
    resize.observe(container);

    window.addEventListener("resize", reposition);
    reposition();

    return () => {
      if (frame) cancelAnimationFrame(frame);
      mutation.disconnect();
      resize.disconnect();
      window.removeEventListener("resize", reposition);
    };
    // Instance is per-mount; repositioning is observer-driven.
  }, []);

  if (connections.length === 0) return null;

  return (
    <div ref={containerRef} className="relative">
      {sorted.map((conn) => (
        <div key={conn.id} className={CARD_WIDTH_CLASS[compact ? "compact" : "full"]}>
          <QuotaCard
            connection={conn}
            quota={quotaData[conn.id]}
            loading={!!loading[conn.id]}
            error={errors[conn.id] || null}
            refreshedAt={lastRefreshedAt[conn.id]}
            emailsVisible={emailsVisible}
            providerLabel={providerLabels[conn.provider] || conn.provider}
            onRefresh={() => onRefresh(conn.id, conn.provider)}
            onOpenCutoff={() => onOpenCutoff(conn)}
            onOpenResetCredits={() => onOpenResetCredits?.(conn.id, conn.provider)}
            onToggleActive={(nextActive) => onToggleActive(conn.id, nextActive)}
            togglingActive={togglingActiveId === conn.id}
            redeemingResetCredit={redeemingResetCreditId === conn.id}
            loadingResetCredits={loadingResetCreditsId === conn.id}
            quotaVisibility={quotaVisibility}
            onHideQuota={
              onHideQuota
                ? (q) => onHideQuota({ connectionId: conn.id, provider: conn.provider }, q)
                : undefined
            }
            onShowQuota={
              onShowQuota
                ? (q) => onShowQuota({ connectionId: conn.id, provider: conn.provider }, q)
                : undefined
            }
          />
        </div>
      ))}
    </div>
  );
}
