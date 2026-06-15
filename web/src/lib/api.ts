import type { SnapshotResponse, CoverageSummary, RunObservabilitySummary } from "~/lib/types";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  snapshot: (events = 80) => getJson<SnapshotResponse>(`/api/snapshot?events=${events}`),
  timeline: (entityId: string) => getJson<{ entityId: string; entityType?: string; items: unknown[] }>(`/api/timeline/${encodeURIComponent(entityId)}`),
  report: async (sliceId: string) => {
    const res = await fetch(`/api/report/${encodeURIComponent(sliceId)}`);
    if (!res.ok) throw new Error(`report ${sliceId} → ${res.status}`);
    return res.text();
  },
  searchSpecs: (q: string, params: Record<string, string> = {}) =>
    getJson<{ query: string; matches: unknown[] }>(`/api/search/specs?${new URLSearchParams({ q, ...params })}`),
  source: (id: string) => getJson<{ source: unknown; markdown: string }>(`/api/source/${encodeURIComponent(id)}`),
  historyRuns: () => getJson<{ historyRoot: string; exists: boolean; runs: unknown[] }>(`/api/history/runs`),
  historyRun: (id: string) => getJson<Record<string, unknown>>(`/api/history/run/${encodeURIComponent(id)}`),
  historyCompare: (left?: string, right?: string) =>
    getJson<Record<string, unknown>>(`/api/history/compare${left && right ? `?left=${left}&right=${right}` : ""}`),
  coverage: () => getJson<CoverageSummary>("/api/coverage"),
  runObservability: () => getJson<RunObservabilitySummary>("/api/run-observability"),
  agentEvents: (actor: string, limit = 500) =>
    getJson<{ actor: string; events: import("~/lib/types").HarnessEvent[] }>(
      `/api/agent-events?actor=${encodeURIComponent(actor)}&limit=${limit}`,
    ),
  focusSlice: (id: string) => getJson<Record<string, unknown>>(`/api/focus/slice/${encodeURIComponent(id)}`),
  focusRun: (id: string) => getJson<Record<string, unknown>>(`/api/focus/run/${encodeURIComponent(id)}`),
};
