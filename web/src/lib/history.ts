// ── Run history helpers ──────────────────────────────────────────────────
// Pure parsing / classification / filtering helpers for the fault-injection sweep
// (api.historyRuns().runs). DOM/store-free so the redesigned History screen stays a
// thin renderer and every rule below is unit-testable. Reuses the established
// cov-badge-* tone families + glyph-with-colour vocabulary — no new colour decisions.

import { humanizeToken } from "~/lib/format";

// Sentence-case a snake/kebab/camelCase key for a label ("graphEdges" → "Graph edges",
// "leftSummary" → "Left summary"). humanizeToken only splits on _/- , so insert a separator
// at camelCase boundaries first, then defer to it for the lowercase-join + capitalize.
export function humanizeKey(key: string): string {
  const spaced = (key ?? "").replace(/([a-z0-9])([A-Z])/g, "$1-$2");
  return humanizeToken(spaced);
}

/** Counts block carried by every run summary (all numeric, may be partial in older runs). */
export interface RunCounts {
  turns?: number;
  verifyRuns?: number;
  lanes?: number;
  slices?: number;
  agentRuns?: number;
  evidence?: number;
  activeEscalations?: number;
  graphNodes?: number;
  graphEdges?: number;
  timelineItems?: number;
}

/** One run as returned by api.historyRuns().runs — structural subset the screen reads. */
export interface HistoryRun {
  runId: string;
  scenario?: string;
  runMode?: string;
  phase?: string;
  driver?: string;
  faultMode?: string;
  startedAt?: string;
  generatedAt?: string;
  finalOutcome?: string;
  finalReason?: string;
  classificationCode?: string;
  classificationSeverity?: string;
  sliceId?: string;
  finalSliceStatus?: string;
  counts?: RunCounts;
  workspace?: string;
  summary?: string;
  artifactIndex?: string;
}

/** Outcome quick-filter buckets for the segmented control. */
export type OutcomeFilter = "all" | "human_required" | "accepted" | "other";

export interface OutcomeTone {
  /** Reused cov-badge-* tone family suffix (fill + text colour). */
  cls: string;
  /** Glyph paired with the colour so the chip never relies on hue alone. */
  glyph: string;
  /** Sentence-case label for the chip. */
  label: string;
  /** True when this row needs a human's eyes (human_required / blocked / failed). */
  attention: boolean;
}

// Outcome → tone. accepted reads green ✓; human_required reads amber ⚠ (needs attention);
// every other terminal outcome (blocked, failed, …) falls back to the classificationSeverity
// then to a red ✕ danger tone so a never-before-seen outcome still reads as "not accepted".
export function outcomeTone(run: Pick<HistoryRun, "finalOutcome" | "classificationSeverity">): OutcomeTone {
  const outcome = run.finalOutcome ?? "";
  if (outcome === "accepted") {
    return { cls: "cov-badge-done", glyph: "✓", label: "Accepted", attention: false };
  }
  if (outcome === "human_required") {
    return { cls: "cov-badge-human", glyph: "⚠", label: "Human required", attention: true };
  }
  const severity = run.classificationSeverity ?? "";
  if (severity === "warning") {
    return { cls: "cov-badge-human", glyph: "⚠", label: humanizeToken(outcome) || "Warning", attention: true };
  }
  // blocked / failed / danger / anything unexpected → red danger tone (needs a human).
  return { cls: "cov-badge-blocked", glyph: "✕", label: humanizeToken(outcome) || "Unknown", attention: true };
}

/** Which outcome-filter bucket a run belongs to. */
export function outcomeBucket(run: Pick<HistoryRun, "finalOutcome">): OutcomeFilter {
  if (run.finalOutcome === "accepted") return "accepted";
  if (run.finalOutcome === "human_required") return "human_required";
  return "other";
}

export interface FaultTone {
  /** cov-badge-* family for the chip; "none" stays neutral. */
  cls: string;
  /** Sentence-case humanized label ("Source mutation"); "none" → "No fault". */
  label: string;
  /** True for an injected fault (anything other than "none"/empty). */
  injected: boolean;
}

// Fault mode → chip. "none" (the clean control runs) reads as a quiet neutral chip; every
// injected fault gets a subtle amber tint so the eye separates control from injected runs.
export function faultLabel(faultMode: string | undefined): FaultTone {
  const mode = (faultMode ?? "").trim();
  if (!mode || mode === "none") {
    return { cls: "cov-badge-not_started", label: "No fault", injected: false };
  }
  return { cls: "cov-badge-human", label: humanizeToken(mode), injected: true };
}

/** The trailing random segment of a runId (e.g. "LAR-…-none-22340" → "22340"); falls back to the whole id. */
export function shortRunId(runId: string | undefined): string {
  if (!runId) return "—";
  const parts = runId.split("-").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : runId;
}

/** Newest-first by startedAt (ISO compare). Pure: returns a new array. */
export function sortByStartedDesc<T extends Pick<HistoryRun, "startedAt">>(runs: T[]): T[] {
  return [...runs].sort((a, b) => {
    const sa = a.startedAt ?? "";
    const sb = b.startedAt ?? "";
    return sa < sb ? 1 : sa > sb ? -1 : 0;
  });
}

export interface RunFilters {
  outcome?: OutcomeFilter;
  fault?: string; // "all" | a faultMode value
  query?: string;
}

// Apply the three controls (outcome quick-filter, fault-mode select, free-text search) in one
// pass. Search matches runId / finalReason / sliceId / classificationCode case-insensitively.
export function filterRuns<T extends HistoryRun>(runs: T[], filters: RunFilters = {}): T[] {
  const outcome = filters.outcome ?? "all";
  const fault = filters.fault ?? "all";
  const ql = (filters.query ?? "").trim().toLowerCase();
  return runs.filter((r) => {
    if (outcome !== "all" && outcomeBucket(r) !== outcome) return false;
    if (fault !== "all" && (r.faultMode ?? "none") !== fault) return false;
    if (ql) {
      const hay = [r.runId, r.finalReason, r.sliceId, r.classificationCode]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!hay.includes(ql)) return false;
    }
    return true;
  });
}

export interface OutcomeCount {
  outcome: string;
  count: number;
  tone: OutcomeTone;
}

export interface FaultCount {
  fault: string;
  count: number;
  tone: FaultTone;
}

export interface HistorySummary {
  total: number;
  /** Outcome breakdown, accepted first then attention-needing outcomes, each with its tone. */
  byOutcome: OutcomeCount[];
  /** Fault-mode distribution, "none" first then injected faults, most-common first within each. */
  byFault: FaultCount[];
  /** Convenience: how many runs need a human (non-accepted). */
  needsAttention: number;
}

// Glanceable "what's in here" summary: outcome breakdown + fault-mode distribution.
export function summarize(runs: HistoryRun[]): HistorySummary {
  const outcomeMap = new Map<string, number>();
  const faultMap = new Map<string, number>();
  let needsAttention = 0;
  for (const r of runs) {
    const o = r.finalOutcome ?? "unknown";
    outcomeMap.set(o, (outcomeMap.get(o) ?? 0) + 1);
    if (o !== "accepted") needsAttention += 1;
    const f = r.faultMode ?? "none";
    faultMap.set(f, (faultMap.get(f) ?? 0) + 1);
  }
  // accepted first, then the rest by descending count.
  const byOutcome: OutcomeCount[] = [...outcomeMap.entries()]
    .map(([outcome, count]) => ({ outcome, count, tone: outcomeTone({ finalOutcome: outcome }) }))
    .sort((a, b) => {
      if (a.outcome === "accepted") return -1;
      if (b.outcome === "accepted") return 1;
      return b.count - a.count;
    });
  // "none" (control) first, then injected faults by descending count.
  const byFault: FaultCount[] = [...faultMap.entries()]
    .map(([fault, count]) => ({ fault, count, tone: faultLabel(fault) }))
    .sort((a, b) => {
      if (a.fault === "none") return -1;
      if (b.fault === "none") return 1;
      return b.count - a.count;
    });
  return { total: runs.length, byOutcome, byFault, needsAttention };
}

export interface FormattedWhen {
  /** Readable local date, e.g. "10 Jun 2026". */
  date: string;
  /** Wall-clock HH:MM:SS (mono). */
  time: string;
}

// Split an ISO timestamp into a readable date + HH:MM:SS for the WHEN column. Invalid → em-dashes.
export function formatWhen(iso: string | undefined): FormattedWhen {
  if (!iso) return { date: "—", time: "—" };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: "—", time: "—" };
  const date = d.toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
  const time = d.toLocaleTimeString([], { hour12: false });
  return { date, time };
}

// ── Compare-result helpers ───────────────────────────────────────────────
// Structured view-model for api.historyCompare(left,right). The endpoint returns
// { changes (boolean flags), deltas (counts numbers + "a -> b" strings), interpretation
// (summary text), artifacts (file refs), left/right (run snapshots) }. These helpers turn
// the "a -> b" delta strings into structured rows and split count deltas into changed-only,
// so the screen renders a labelled diff (not a raw JSON dump). Degrades gracefully on missing fields.

export interface ComparePair {
  /** Field label, e.g. "Outcome". */
  label: string;
  left: string;
  right: string;
  changed: boolean;
}

const ARROW = "->";

/** Parse a "left -> right" delta string into { left, right }; whole string → left when no arrow. */
export function parseArrow(delta: string | undefined): { left: string; right: string } {
  if (!delta) return { left: "", right: "" };
  const idx = delta.indexOf(ARROW);
  if (idx === -1) return { left: delta.trim(), right: delta.trim() };
  return { left: delta.slice(0, idx).trim(), right: delta.slice(idx + ARROW.length).trim() };
}

export interface CompareCountRow {
  label: string;
  delta: number;
}

// Pick the non-zero count deltas, label them humanized, biggest absolute change first.
export function compareCountRows(deltas: Record<string, number> | undefined): CompareCountRow[] {
  if (!deltas) return [];
  return Object.entries(deltas)
    .filter(([, v]) => typeof v === "number" && v !== 0)
    .map(([key, v]) => ({ label: humanizeKey(key), delta: v }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

export interface CompareView {
  interpretation: string;
  /** Outcome / classification / fault rows as structured left-vs-right pairs. */
  pairs: ComparePair[];
  /** Non-zero count deltas. */
  counts: CompareCountRow[];
  /** Artifact file references (key → path). */
  artifacts: Array<{ label: string; path: string }>;
  anyChange: boolean;
}

// Shape the raw compare payload into a render-ready view-model. Tolerant of missing fields.
export function buildCompareView(raw: Record<string, unknown> | null | undefined): CompareView {
  const r = (raw ?? {}) as Record<string, any>;
  const changes = (r.changes ?? {}) as Record<string, boolean>;
  const deltas = (r.deltas ?? {}) as Record<string, any>;
  const pairs: ComparePair[] = [
    { key: "finalOutcome", changeKey: "finalOutcomeChanged", label: "Outcome" },
    { key: "classification", changeKey: "classificationChanged", label: "Classification" },
    { key: "faultMode", changeKey: "faultModeChanged", label: "Fault mode" },
  ]
    .map(({ key, changeKey, label }) => {
      const { left, right } = parseArrow(typeof deltas[key] === "string" ? deltas[key] : undefined);
      return { label, left, right, changed: Boolean(changes[changeKey]) };
    })
    .filter((p) => p.left || p.right);
  const counts = compareCountRows(deltas.counts as Record<string, number> | undefined);
  const artifacts = Object.entries((r.artifacts ?? {}) as Record<string, string>)
    .filter(([, v]) => typeof v === "string" && v)
    .map(([key, path]) => ({ label: humanizeKey(key), path }));
  const anyChange = Object.values(changes).some(Boolean) || counts.length > 0;
  return {
    interpretation: typeof r.interpretation === "string" ? r.interpretation : "",
    pairs,
    counts,
    artifacts,
    anyChange,
  };
}
