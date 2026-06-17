import type { EscalationRecord } from "~/lib/types";

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export interface CmdToken { text: string; kind: "exe" | "flag" | "arg"; }
// Split a (already prettified) command into styled tokens: first token = executable/subject,
// tokens starting with - or -- (after any leading quote) = flags, everything else = args.
export function tokenizeCommand(s: string): CmdToken[] {
  const parts = s.split(/\s+/).filter(Boolean);
  return parts.map((p, i) => {
    if (i === 0) return { text: p.replace(/^["']|["']$/g, ""), kind: "exe" as const };
    const bare = p.replace(/^["']+/, "");
    if (/^-{1,2}[A-Za-z]/.test(bare)) return { text: p, kind: "flag" as const };
    return { text: p, kind: "arg" as const };
  });
}

const VERB: Record<string, string> = {
  idle: "Idle", thinking: "Thinking", reading: "Reading", editing: "Editing",
  testing: "Running", verifying: "Verifying", waiting: "Waiting", blocked: "Blocked",
};
export function activityVerb(state: string | undefined): string {
  return (state && VERB[state]) || "Active";
}

// Collapse any path-like token to its basename (handles quoted paths with spaces, drive letters, relative, posix).
export function prettifyTarget(target: string): string {
  if (!target) return target;
  let out = target;
  // quoted paths (may contain spaces): "C:\Program Files\...\x.exe", '.\a\b.md', "/a/b.md", 'C:\Users\..\SKILL.md'
  out = out.replace(/(["'])((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])[^"']*)\1/g, (_m, q, p) => {
    const base = String(p).split(/[\\/]/).filter(Boolean).pop() || p;
    return q + base + q;
  });
  // unquoted path tokens (no spaces): C:\a\b\x.exe, ./a/b, /a/b/c.md, .\a\b
  // Use lookbehind to ensure lone / or \ only matches when at word boundary (not mid-token like src/x.ts)
  out = out.replace(/(?:(?<=[^A-Za-z0-9_]|^)[\\/]|[A-Za-z]:[\\/]|\.{1,2}[\\/])[^\s"']+/g, (m) => {
    const base = m.split(/[\\/]/).filter(Boolean).pop() || m;
    return base;
  });
  return out;
}

export interface CommandSummary { present: string; past: string; target?: string; }
// Turn a raw shell command into concise semantic actions (present + past tense). Unwraps the pwsh/-Command wrapper.
export function summarizeCommand(raw: string): CommandSummary {
  if (!raw) return { present: "", past: "" };
  let cmd = raw.trim();
  // unwrap: "...pwsh.exe" -Command "<inner>"  (or single-quoted inner)
  const pwsh = cmd.match(/pwsh(?:\.exe)?"?\s+-Command\s+(["'])([\s\S]*)\1\s*$/i);
  if (pwsh) cmd = pwsh[2].trim();
  const stripQ = (p: string) => p.replace(/^['"]|['"]$/g, "");
  // show a path: keep short relative paths; collapse absolute/long to basename
  const showPath = (p: string) => {
    const s = stripQ(p);
    const isAbs = /^[A-Za-z]:[\\/]/.test(s) || s.startsWith("/");
    if (isAbs || s.length > 40) return s.split(/[\\/]/).filter(Boolean).pop() || s;
    return s;
  };
  let m: RegExpMatchArray | null;
  if (/^["']?node["']?\b/i.test(cmd) && /\s-e\b/.test(cmd)) return { present: "running script", past: "ran script" };
  if ((m = cmd.match(/get-content\s+(?:-raw\s+|-literalpath\s+|-path\s+)*(['"]?[^'"|<>]+?['"]?)\s*$/i))) return { present: "reading", past: "read", target: showPath(m[1]) };
  if ((m = cmd.match(/^\s*(?:cat|type)\s+(\S+)/i))) return { present: "reading", past: "read", target: showPath(m[1]) };
  if (/test-path/i.test(cmd)) return { present: "checking path", past: "checked path" };
  if ((m = cmd.match(/\bgit\b[\s\S]*?\b(status|diff|log|add|commit|show|rev-parse|init)\b/i))) {
    const sub = m[1].toLowerCase();
    return { present: `running git ${sub}`, past: `git ${sub}` };
  }
  if (/\bnpm\s+(run\s+)?test\b|\bnode\s+--test\b|\bvitest\b|\bpytest\b/i.test(cmd)) return { present: "running tests", past: "ran tests" };
  if (/\bnpm\s+run\s+build\b|\btsc\b/i.test(cmd)) return { present: "building", past: "built" };
  if (/\brg\b|\bgrep\b|select-string|findstr/i.test(cmd)) return { present: "searching", past: "searched" };
  if (/get-childitem|^\s*ls\b|^\s*dir\b/i.test(cmd)) return { present: "listing files", past: "listed files" };
  // fallback: first token as action, lightly-cleaned remainder as target
  const parts = cmd.split(/\s+/);
  const head = stripQ(parts[0]).split(/[\\/]/).filter(Boolean).pop() || stripQ(parts[0]);
  const rest = parts.slice(1).join(" ");
  return { present: `running ${head}`, past: `ran ${head}`, target: rest ? (rest.length > 50 ? rest.slice(0, 50) + "…" : rest) : undefined };
}

// Pick present/past phrasing for an activity whose target may be a command OR a bare file path.
export function describeActivity(a: { state?: string; target?: string }): { present: string; past: string; target?: string } {
  const t = a.target ?? "";
  if (!t) {
    const s = a.state ?? "working";
    const map: Record<string, [string, string]> = { thinking: ["thinking", "thought"], idle: ["idle", "idle"], waiting: ["waiting", "waited"], verifying: ["verifying", "verified"], reading: ["reading", "read"], editing: ["editing", "edited"], testing: ["testing", "tested"], blocked: ["blocked", "blocked"] };
    const [present, past] = map[s] ?? [s, s];
    return { present, past };
  }
  if (/\s/.test(t) || /pwsh|get-content|git\b|npm\b|node\b|\brg\b|select-string|test-path|get-childitem/i.test(t)) {
    return summarizeCommand(t);
  }
  // bare file path → phrase by state
  const file = t.replace(/^['"]|['"]$/g, "");
  const base = (/^[A-Za-z]:[\\/]/.test(file) || file.length > 40) ? (file.split(/[\\/]/).filter(Boolean).pop() || file) : file;
  switch (a.state) {
    case "editing": return { present: "editing", past: "edited", target: base };
    case "reading": return { present: "reading", past: "read", target: base };
    case "testing": return { present: "testing", past: "tested", target: base };
    default: return { present: a.state ?? "working", past: a.state ?? "did", target: base };
  }
}

// Local wall-clock HH:MM:SS for an ISO timestamp; "" when invalid.
export function fmtClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour12: false });
}

// Compact relative age: "now" / "Ns" / "Nm" / "Nh".
export function shortAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return "now";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h`;
}

export type LivenessLevel = "alive" | "quiet" | "stale" | "dead" | "done";
// Classify per-agent liveness from run status + last-signal age.
//
// A stall alarm ("dead") is only meaningful when the agent is EXPECTED to be signaling — i.e. it
// has a live (running) run. A finished run (completed/released/failed) or no run at all — e.g. a
// deterministic verify step that emits heartbeats but spawns no agent process — is idle, NOT
// stalled: "no signal" is expected and irrelevant there, so it maps to "done". Only a running run
// gone silent, or a run the harness itself flagged `stale`, counts as a genuine stall.
export function livenessLevel(runStatus: string | undefined, ageMs: number): LivenessLevel {
  if (runStatus === "running") {
    if (ageMs < 15_000) return "alive";
    if (ageMs < 60_000) return "quiet";
    if (ageMs < 300_000) return "stale";
    return "dead";
  }
  if (runStatus === "stale") return "dead"; // harness already marked the run stalled
  return "done"; // completed | released | failed | undefined (no live run) → idle, not expected to signal
}

// Operator-facing one-word state derived from a liveness level: active (live & signaling),
// stalled (live but no signal), or idle (no live run — finished or never started).
export function livenessLabel(level: LivenessLevel): "active" | "idle" | "stalled" {
  if (level === "dead") return "stalled";
  if (level === "done") return "idle";
  return "active";
}

export interface EscalationGroup {
  key: string;
  level: EscalationRecord["level"];
  entityType: string;
  entityId: string;
  message: string;       // latest representative message
  latest: string;        // latest updatedAt
  count: number;
  instances: EscalationRecord[];
}

export function normalizeEscalationMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/[a-z]:\\[^\s]+/g, "<path>")     // windows paths
    .replace(/\/[^\s]+/g, "<path>")            // posix paths
    .replace(/\(\d+[^)]*\)/g, "(<n>)")         // "(3 items)"
    .replace(/\d+/g, "<n>")                     // bare numbers
    .replace(/\s+/g, " ")
    .trim();
}

export function groupEscalations(list: EscalationRecord[]): EscalationGroup[] {
  const map = new Map<string, EscalationGroup>();
  for (const esc of list) {
    const key = `${esc.entityType}:${esc.entityId}:${esc.level}:${normalizeEscalationMessage(esc.message)}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { key, level: esc.level, entityType: esc.entityType, entityId: esc.entityId, message: esc.message, latest: esc.updatedAt, count: 1, instances: [esc] });
    } else {
      existing.count += 1;
      existing.instances.push(esc);
      if (esc.updatedAt > existing.latest) { existing.latest = esc.updatedAt; existing.message = esc.message; }
    }
  }
  // most severe + most recent first
  const order: Record<EscalationRecord["level"], number> = { critical: 0, human_required: 1, blocker: 2, warning: 3, info: 4 };
  return Array.from(map.values()).sort((a, b) => order[a.level] - order[b.level] || (a.latest < b.latest ? 1 : -1));
}

export const FRAC_RE = /\b(?:FR|AC)-[A-Z0-9]+(?:-[A-Z0-9]+)*(?:\.[0-9]+)?\b/gi;

/** Extract and deduplicate FR/AC reference identifiers from a markdown string. */
export function extractFrAcRefs(text: string): string[] {
  const matches = text.match(FRAC_RE) ?? [];
  return [...new Set(matches.map((m) => m.toUpperCase()))].sort();
}

/**
 * Humanize a snake_case / kebab enum token into a sentence-case label: split on
 * _ or -, lowercase every word, then capitalize the first letter of the first
 * word only ('command_failed' → 'Command failed', 'run_stale' → 'Run stale',
 * 'turn_started' → 'Turn started'). Empty/blank → "".
 */
export function humanizeToken(s: string): string {
  const words = (s ?? "").trim().split(/[_-]+/).filter(Boolean);
  if (words.length === 0) return "";
  const joined = words.map((w) => w.toLowerCase()).join(" ");
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

// Display title for a slice: drop the leading "Implement " verb and a trailing FR/AC ref
// dump like "(AC-API-001.1, AC-API-001.2, …)" so the title reads as the deliverable, not a
// wall of refs (the refs are shown separately as chips/dots).
export function cleanSliceTitle(title: string): string {
  return (title ?? "")
    .replace(/^\s*implement\s+/i, "")
    .replace(/\s*\([^)]*\b(?:AC|FR)-[^)]*\)\s*$/i, "")
    .trim();
}

/** Sentence-case display label for a coverage status string. First word capitalized only. */
export function statusLabel(status: string): string {
  switch (status) {
    case "done": return "Done";
    case "in_progress": return "In progress";
    case "blocked": return "Blocked";
    case "failed": return "Failed";
    case "not_started": return "Not started";
    default: return "Not indexed";
  }
}

// ── Work board: slice status grouping, priority, and per-status tone ────────
// The board collapses the 11 SliceStatus values into 5 operator buckets and
// orders active work most-urgent-first, so the wide centre stage shows a
// glanceable distribution + a priority-sorted grid instead of five columns.

export type SliceStatusGroup = "queued" | "implementing" | "review" | "blocked" | "accepted";

// Map a raw SliceStatus to its operator bucket. Terminal (accepted/closed) → "accepted".
export function sliceStatusGroup(status: string): SliceStatusGroup {
  switch (status) {
    case "candidate": case "ready": case "claimed": return "queued";
    case "implementing": case "implemented": case "repairing": return "implementing";
    case "verifying": case "ready_for_review": return "review";
    case "blocked": return "blocked";
    default: return "accepted"; // accepted | closed | anything unexpected
  }
}

/** A slice is terminal (done work) when accepted or closed; everything else is active. */
export function isTerminalSlice(status: string): boolean {
  return status === "accepted" || status === "closed";
}

// Priority for the active grid: blocked (most urgent) → review → implementing → queued.
// Lower = sorted first. Terminal/unknown sink to the bottom (kept out of the active grid anyway).
const ACTIVE_PRIORITY: Record<SliceStatusGroup, number> = {
  blocked: 0, review: 1, implementing: 2, queued: 3, accepted: 4,
};
export function activeSlicePriority(status: string): number {
  return ACTIVE_PRIORITY[sliceStatusGroup(status)];
}

// Structural subset the board sort needs — keeps the helper DOM/store-free for unit tests.
export interface SortableSlice { status: string; updatedAt: string; }

/**
 * Sort active (non-terminal) slices most-urgent-first: by ACTIVE_PRIORITY group
 * (blocked > review > implementing > queued), tiebreak newest updatedAt first.
 * Pure + stable-ish (returns a new array; does not mutate the input).
 */
export function sortActiveSlices<T extends SortableSlice>(slices: T[]): T[] {
  return [...slices].sort((a, b) => {
    const pa = activeSlicePriority(a.status);
    const pb = activeSlicePriority(b.status);
    if (pa !== pb) return pa - pb;
    return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
  });
}

export interface SliceStatusTone {
  /** Reused cov-badge-* / lv-* tone family suffix for the chip fill+text. */
  cls: string;
  /** Glyph paired with the colour so the chip never relies on hue alone. */
  glyph: string;
  /** Sentence-case label for the chip + overview strip. */
  label: string;
}

// Status-group tones, reusing the established semantic hues (blocked=red, review=blue,
// implementing=amber, queued=neutral, accepted=green) — each paired with a glyph.
const STATUS_GROUP_TONES: Record<SliceStatusGroup, SliceStatusTone> = {
  blocked: { cls: "wb-chip-blocked", glyph: "✕", label: "Blocked" },
  review: { cls: "wb-chip-review", glyph: "◐", label: "Review" },
  implementing: { cls: "wb-chip-implementing", glyph: "▸", label: "Implementing" },
  queued: { cls: "wb-chip-queued", glyph: "○", label: "Queued" },
  accepted: { cls: "wb-chip-accepted", glyph: "✓", label: "Accepted" },
};

/** Chip tone (class + glyph + group label) for a slice's status group. */
export function sliceStatusGroupTone(status: string): SliceStatusTone {
  return STATUS_GROUP_TONES[sliceStatusGroup(status)];
}

/**
 * A precise per-status chip label (humanized actual status, e.g. "Ready for review",
 * "Repairing") paired with its GROUP tone — so the chip is exact while the colour stays
 * within the five-bucket vocabulary.
 */
export function sliceStatusChip(status: string): SliceStatusTone {
  const tone = sliceStatusGroupTone(status);
  return { cls: tone.cls, glyph: tone.glyph, label: humanizeToken(status) || tone.label };
}

export interface StatusOverviewCount { group: SliceStatusGroup; label: string; count: number; }

// Fixed display order for the overview strip: the four active buckets first
// (queued → implementing → review → blocked), Accepted last as the green tail.
const OVERVIEW_ORDER: SliceStatusGroup[] = ["queued", "implementing", "review", "blocked", "accepted"];

/** Per-group counts for the overview strip, in OVERVIEW_ORDER (always all five, zeros included). */
export function statusOverviewCounts(slices: Array<{ status: string }>): StatusOverviewCount[] {
  const tally: Record<SliceStatusGroup, number> = { queued: 0, implementing: 0, review: 0, blocked: 0, accepted: 0 };
  for (const s of slices) tally[sliceStatusGroup(s.status)] += 1;
  return OVERVIEW_ORDER.map((group) => ({ group, label: STATUS_GROUP_TONES[group].label, count: tally[group] }));
}

// ── Spec Build Map helpers ──────────────────────────────────────────────
// A single shared status vocabulary joined to the existing Coverage tone classes
// (cov-badge-*) so the Specs screen introduces zero new color decisions. Every
// status is paired with a glyph so color is never the sole signal.

export type RefStatus = "done" | "in_progress" | "blocked" | "failed" | "not_started";

export interface RefTone {
  /** Existing cov-badge-* suffix (or "unindexed" for a neutral, non-clickable chip). */
  cls: string;
  /** Glyph paired with the color so the state reads without relying on hue. */
  glyph: string;
  /** Sentence-case label for legends / tooltips. */
  label: string;
}

const TONES: Record<string, RefTone> = {
  done: { cls: "cov-badge-done", glyph: "✓", label: "Done" },
  in_progress: { cls: "cov-badge-in_progress", glyph: "◐", label: "In progress" },
  blocked: { cls: "cov-badge-blocked", glyph: "✕", label: "Blocked" },
  failed: { cls: "cov-badge-failed", glyph: "✕", label: "Failed" },
  not_started: { cls: "cov-badge-not_started", glyph: "○", label: "Not started" },
};

// "–" (not "◌") so it stays legible and clearly distinct from not_started's ○ at chip size.
const UNINDEXED_TONE: RefTone = { cls: "spec-ref-unindexed", glyph: "–", label: "Not indexed" };

/** Map a coverage status (or undefined → unindexed) to its reused tone class + glyph + label. */
export function refTone(status?: string): RefTone {
  if (!status) return UNINDEXED_TONE;
  return TONES[status] ?? UNINDEXED_TONE;
}

// Severity precedence for the worst-status roll-up: a present failure/blocker
// dominates, then in-progress, then not-started, and only all-done reads green.
const SEVERITY: Record<RefStatus, number> = {
  failed: 5,
  blocked: 4,
  in_progress: 3,
  not_started: 2,
  done: 1,
};

/** Most severe status present among a set of statuses (undefined → no indexed refs). */
export function worstStatus(statuses: Array<string | undefined>): RefStatus | undefined {
  let worst: RefStatus | undefined;
  for (const s of statuses) {
    if (!s || !(s in SEVERITY)) continue;
    const st = s as RefStatus;
    if (worst === undefined || SEVERITY[st] > SEVERITY[worst]) worst = st;
  }
  return worst;
}

export interface RefCounts {
  total: number;
  done: number;
  inProgress: number;
  blockedFailed: number;
  notStarted: number;
  indexed: number;
}

/** Tally per-status counts for a list of refs against a coverage refMap. */
export function countRefStatuses(refs: string[], refMap: Map<string, { status: string }>): RefCounts {
  const c: RefCounts = { total: refs.length, done: 0, inProgress: 0, blockedFailed: 0, notStarted: 0, indexed: 0 };
  for (const ref of refs) {
    const r = refMap.get(ref.toUpperCase());
    if (!r) continue;
    c.indexed += 1;
    if (r.status === "done") c.done += 1;
    else if (r.status === "in_progress") c.inProgress += 1;
    else if (r.status === "blocked" || r.status === "failed") c.blockedFailed += 1;
    else if (r.status === "not_started") c.notStarted += 1;
  }
  return c;
}

// Family ordering for the requirement ledger — domain-ish prefixes first in a
// stable, meaningful order, everything else alphabetical, "Other" last.
const FAMILY_ORDER = ["API", "UI", "DATA", "NFR", "QA", "SMOKE", "PROD"];

/** The family segment of a ref: the token immediately after FR-/AC- (else "Other"). */
export function refFamily(ref: string): string {
  const m = /^(?:FR|AC)-([A-Za-z]+)/i.exec(ref);
  return m ? m[1].toUpperCase() : "Other";
}

export interface RefFamilyGroup {
  family: string;
  refs: string[];
}

/** Group extracted refs by family, ordered per FAMILY_ORDER then alphabetical, "Other" last. */
export function groupRefsByFamily(refs: string[]): RefFamilyGroup[] {
  const map = new Map<string, string[]>();
  for (const ref of refs) {
    const fam = refFamily(ref);
    const list = map.get(fam);
    if (list) list.push(ref);
    else map.set(fam, [ref]);
  }
  const rank = (fam: string) => {
    if (fam === "Other") return 1e6;
    const i = FAMILY_ORDER.indexOf(fam);
    return i === -1 ? 1000 : i;
  };
  return Array.from(map.entries())
    .map(([family, list]) => ({ family, refs: [...list].sort() }))
    .sort((a, b) => {
      const ra = rank(a.family);
      const rb = rank(b.family);
      if (ra !== rb) return ra - rb;
      return a.family.localeCompare(b.family);
    });
}

// Deterministic category tint for a card spine — a CATEGORY signal (never status).
// Cycles the existing accent/semantic hues at a calm alpha. Same domain → same tint.
const SPINE_TINTS = [
  "rgba(91,157,255,0.7)", // --blue / --accent
  "rgba(167,139,250,0.7)", // --violet
  "rgba(92,184,122,0.7)", // --green
  "rgba(214,161,60,0.7)", // --amber
  "rgba(91,157,255,0.5)", // --accent (lighter)
];

/** Stable per-domain spine tint (category color, not status). Empty/undefined → faint line. */
export function domainTint(domain: string | undefined): string {
  if (!domain) return "rgba(255,255,255,0.18)";
  let h = 0;
  for (let i = 0; i < domain.length; i += 1) h = (h * 31 + domain.charCodeAt(i)) >>> 0;
  return SPINE_TINTS[h % SPINE_TINTS.length];
}

/** Slugify a heading into a URL-safe id (caller de-dupes with a counter). */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "section";
}

export interface TocEntry {
  text: string;
  slug: string;
  level: number; // 2 = ##, 3 = ###
}

/** Parse ## / ### headings from markdown into TOC entries with de-duplicated slugs. */
export function parseHeadings(md: string): TocEntry[] {
  const entries: TocEntry[] = [];
  const seen = new Map<string, number>();
  const lines = md.split("\n");
  let inFence = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const level = m[1].length;
    // strip inline markdown emphasis/code/link syntax for a clean label + slug base
    const text = m[2]
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .trim();
    let slug = slugify(text);
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    if (n > 0) slug = `${slug}-${n}`;
    entries.push({ text, slug, level });
  }
  return entries;
}

export function formatAge(iso: string, now: number = Date.now()): string {
  const ms = Math.max(0, now - Date.parse(iso));
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Agent roster grouping ───────────────────────────────────────────────
// The roster is grouped by ROLE, active-first within each group, with the long idle tail
// truncated. Pure helpers here so the ordering/partitioning is unit-testable without a DOM.

// Minimal shape the grouping needs — a structural subset of AgentRosterRow so the helper has no
// dependency on the store module (and tests can build rows inline).
export interface RosterGroupRow { actor: string; role?: string; latest: string; runStatus?: string; }

// Group order: overseer first (the conductor), then the worker→reviewer→verifier delivery chain,
// then planner, then recovery; any unknown/absent role sinks to the bottom.
const ROLE_ORDER = ["overseer", "worker", "reviewer", "verifier", "planner", "recovery"];

// Sentence-case plural label per role for the group eyebrow (e.g. "Reviewers"). "recovery" has no
// natural plural, so it stays as the section name "Recovery". Unknown roles render humanized.
const ROLE_LABELS: Record<string, string> = {
  overseer: "Overseers", worker: "Workers", reviewer: "Reviewers",
  verifier: "Verifiers", planner: "Planners", recovery: "Recovery",
};

/** Group eyebrow label for a role bucket: the plural map, else a humanized fallback, else "Other". */
export function roleGroupLabel(role: string | undefined): string {
  if (!role) return "Other";
  return ROLE_LABELS[role] ?? (humanizeToken(role) || "Other");
}

// active (alive/quiet/stale) first, then stalled (dead), then idle (done) — so the operator's eye
// lands on live work, then on stalls that need rescue, with the dormant tail last.
const STATE_RANK: Record<"active" | "stalled" | "idle", number> = { active: 0, stalled: 1, idle: 2 };

export interface RosterGroup<T extends RosterGroupRow> {
  role: string;            // the role key ("overseer", …) or "" for the unknown bucket
  label: string;           // group eyebrow label (e.g. "Reviewers")
  count: number;           // total rows in the group (active + stalled + idle)
  active: T[];             // active + stalled rows — always shown in full
  idle: T[];               // idle rows — truncated to a cap with a "+N idle" toggle
}

/**
 * Group roster rows by role (ROLE_ORDER, unknown last), and within each group sort ACTIVE-FIRST by
 * liveness (active → stalled → idle, then by actor name). Each group splits into `active` (active +
 * stalled rows, always rendered) and `idle` (the dormant tail the component truncates). Empty
 * groups are omitted. `now` lets tests pin the liveness clock.
 */
export function groupAgentsByRole<T extends RosterGroupRow>(rows: T[], now: number = Date.now()): RosterGroup<T>[] {
  const stateOf = (r: RosterGroupRow): "active" | "stalled" | "idle" =>
    livenessLabel(livenessLevel(r.runStatus, now - Date.parse(r.latest)));
  const rank = (role: string | undefined) => {
    const i = ROLE_ORDER.indexOf(role ?? "");
    return i === -1 ? ROLE_ORDER.length : i;
  };
  const buckets = new Map<string, T[]>();
  for (const r of rows) {
    const key = r.role && ROLE_ORDER.includes(r.role) ? r.role : (r.role ?? "");
    const list = buckets.get(key);
    if (list) list.push(r); else buckets.set(key, [r]);
  }
  return Array.from(buckets.entries())
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([role, list]) => {
      const sorted = [...list].sort((x, y) =>
        STATE_RANK[stateOf(x)] - STATE_RANK[stateOf(y)] || x.actor.localeCompare(y.actor));
      const active = sorted.filter((r) => stateOf(r) !== "idle");
      const idle = sorted.filter((r) => stateOf(r) === "idle");
      return { role, label: roleGroupLabel(role || undefined), count: sorted.length, active, idle };
    });
}

// One raw activity entry pulled from an agent_event (state + target + the event timestamp).
export interface ActivityEntry { state?: string; target?: string; ts: string; }
// A compacted line: a run of consecutive same-verb actions collapsed into one row.
export interface ActivityGroup { verb: string; targets: string[]; startTs: string; endTs: string; count: number; }

// Collapse a (chronological) list of activity entries into compact lines: CONSECUTIVE entries that
// share the same past-tense verb (per describeActivity) become one group; their cleaned targets are
// deduped and collected. Entries are expected ASC by timestamp; the result preserves that order.
export function groupRunActivity(entries: ActivityEntry[]): ActivityGroup[] {
  const sorted = [...entries].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const groups: ActivityGroup[] = [];
  for (const e of sorted) {
    const d = describeActivity({ state: e.state, target: e.target });
    const verb = d.past;
    const target = d.target;
    const last = groups[groups.length - 1];
    if (last && last.verb === verb) {
      last.endTs = e.ts;
      last.count += 1;
      if (target && !last.targets.includes(target)) last.targets.push(target);
      continue;
    }
    groups.push({ verb, targets: target ? [target] : [], startTs: e.ts, endTs: e.ts, count: 1 });
  }
  return groups;
}
