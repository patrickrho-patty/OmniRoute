"use client";

import { useEffect, useState } from "react";

type PonytailAggregate = {
  engineId: string;
  runs: number;
  tokensSaved: number;
  avgSavingsPercent: number;
  days: number;
};

type PonytailRun = {
  timestamp: string;
  requestId: string | null;
  originalTokens: number;
  compressedTokens: number;
  tokensSaved: number;
  durationMs: number | null;
};

type PonytailResponse = {
  engine: string;
  since: string;
  aggregate: PonytailAggregate;
  history: PonytailRun[];
};

const SINCE_OPTIONS: Array<{ value: "24h" | "7d" | "30d" | "all"; label: string }> = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
];

function formatInt(n: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(n || 0));
}

function StatCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: string;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="card p-4 flex flex-col gap-1">
      <div className="flex items-center gap-2 text-text-muted text-sm">
        <span className="material-symbols-outlined text-[18px]">{icon}</span>
        {label}
      </div>
      <div className="text-2xl font-bold text-text">{value}</div>
      {sub && <div className="text-xs text-text-muted">{sub}</div>}
    </div>
  );
}

export default function PonytailHistoryPage() {
  const [data, setData] = useState<PonytailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [since, setSince] = useState<"24h" | "7d" | "30d" | "all">("7d");
  const [reloadTick, setReloadTick] = useState(0);

  // Fetch directly in the effect, mutating state only inside the async callbacks
  // (a synchronous setState in the effect body trips react-hooks/set-state-in-effect).
  // The Refresh button bumps `reloadTick` to re-run the effect.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/analytics/compression?engine=ponytail&since=${since}&limit=100`)
      .then((r) => {
        if (!r.ok) throw new Error(`Request failed (${r.status})`);
        return r.json();
      })
      .then((json: PonytailResponse) => {
        if (cancelled) return;
        setData(json);
        setError(null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [since, reloadTick]);

  const history = data?.history ?? [];
  const sampledContext = history.reduce((sum, r) => sum + (r.originalTokens || 0), 0);
  const avgContext = history.length ? Math.round(sampledContext / history.length) : 0;

  return (
    <div className="flex flex-col gap-6 p-1">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-bold text-text flex items-center gap-2">
            <span className="material-symbols-outlined">content_cut</span>
            Ponytail
          </h1>
          <p className="text-sm text-text-muted max-w-2xl">
            Ponytail is an <span className="font-medium text-text">augmentation</span> engine — it
            injects lazy-senior-dev YAGNI discipline into endpoint prompts. It does not reduce
            tokens, so{" "}
            <span className="font-medium text-text">0% savings is expected by design</span>; its
            value is in the instruction it adds, not bytes removed.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-border overflow-hidden">
            {SINCE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setSince(opt.value)}
                className={`px-3 py-1.5 text-sm transition-colors ${
                  since === opt.value
                    ? "bg-primary text-white"
                    : "bg-bg text-text-muted hover:bg-bg-muted"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <button
            onClick={() => setReloadTick((t) => t + 1)}
            className="px-3 py-1.5 text-sm rounded-lg border border-border text-text-muted hover:bg-bg-muted flex items-center gap-1"
            title="Refresh"
          >
            <span className="material-symbols-outlined text-[18px]">refresh</span>
          </button>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16 text-text-muted">
          <span className="material-symbols-outlined animate-spin mr-2">progress_activity</span>
          Loading Ponytail history…
        </div>
      )}

      {error && !loading && (
        <div className="card p-6 text-center text-text-muted">
          <span className="material-symbols-outlined text-[32px] mb-2 block">error</span>
          Could not load Ponytail analytics: {error}
        </div>
      )}

      {!loading && !error && data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard
              icon="content_cut"
              label="Runs"
              value={formatInt(data.aggregate.runs)}
              sub={`Last ${data.aggregate.days}d`}
            />
            <StatCard
              icon="data_usage"
              label="Context (recent)"
              value={formatInt(sampledContext)}
              sub={`${history.length} run${history.length === 1 ? "" : "s"} sampled`}
            />
            <StatCard
              icon="straighten"
              label="Avg context / run"
              value={formatInt(avgContext)}
              sub="original tokens"
            />
            <StatCard
              icon="savings"
              label="Token savings"
              value={`${data.aggregate.avgSavingsPercent}%`}
              sub="0% by design (augmentation)"
            />
          </div>

          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px] text-text-muted">history</span>
              <span className="font-medium text-text">Recent runs</span>
              <span className="text-xs text-text-muted">({history.length})</span>
            </div>
            {history.length === 0 ? (
              <div className="p-8 text-center text-text-muted text-sm">
                No Ponytail runs recorded in this window.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-text-muted border-b border-border">
                      <th className="px-4 py-2 font-medium">Time</th>
                      <th className="px-4 py-2 font-medium">Request</th>
                      <th className="px-4 py-2 font-medium text-right">Context tokens</th>
                      <th className="px-4 py-2 font-medium text-right">Saved</th>
                      <th className="px-4 py-2 font-medium text-right">Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((run, i) => (
                      <tr
                        key={`${run.requestId ?? "row"}-${i}`}
                        className="border-b border-border/50 hover:bg-bg-muted/50"
                      >
                        <td className="px-4 py-2 text-text whitespace-nowrap">
                          {new Date(run.timestamp).toLocaleString()}
                        </td>
                        <td className="px-4 py-2 text-text-muted font-mono text-xs">
                          {run.requestId ? run.requestId.slice(0, 8) : "—"}
                        </td>
                        <td className="px-4 py-2 text-right text-text tabular-nums">
                          {formatInt(run.originalTokens)}
                        </td>
                        <td className="px-4 py-2 text-right text-text-muted tabular-nums">
                          {run.tokensSaved === 0 ? "—" : formatInt(run.tokensSaved)}
                        </td>
                        <td className="px-4 py-2 text-right text-text-muted tabular-nums">
                          {run.durationMs == null ? "—" : `${formatInt(run.durationMs)} ms`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
