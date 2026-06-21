// ── Skill Observability (read-only display contract) ─────────────────────────
// The harness binds protocol skills (SKILL.md files) to each agent run and exposes
// the binding additively on snapshot agentRuns[] and on the run-focus packet. These
// shapes are NOT declared on the shared types.ts (user-owned), so the UI reads them
// via tolerant runtime accessors: the shapes are declared (additively/loosely) on the shared
// types.ts, but live data is scraped (ANSI-laden, sometimes truncated), so reading it through
// guards keeps malformed/absent values NEUTRAL — never an error. MANY runs carry no skill data
// (historical / pre-Phase-10D), which is also neutral.
//
// See docs/architecture/skill-observability-ui-contract.md.

export interface SkillSummary {
  id: string;
  requirement: "required" | "optional";
  source: "builtin" | "project" | "path" | string;
  sourcePath: string;
  boundPath: string;
  hash: string;
  title?: string;
  description?: string;
}

export interface SkillBindingSummary {
  role: string;
  runId: string;
  bindingPath: string;
  packetPath: string;
  boundRoot: string;
  required: SkillSummary[];
  optional: SkillSummary[];
  count: number;
}

// Tolerant runtime accessor for run.skills (typed `unknown` on the shared AgentRunRecord).
// Returns the binding only when it is a real object carrying at least one of the
// expected fields; otherwise undefined (so an absent/malformed value renders nothing).
export function skillsOf(run: unknown): SkillBindingSummary | undefined {
  if (run == null || typeof run !== "object") return undefined;
  const raw = (run as Record<string, unknown>).skills;
  if (raw == null || typeof raw !== "object") return undefined;
  const b = raw as Record<string, unknown>;
  const required = Array.isArray(b.required) ? (b.required as SkillSummary[]) : [];
  const optional = Array.isArray(b.optional) ? (b.optional as SkillSummary[]) : [];
  // A binding with neither stacks AND no count is empty/noise → treat as absent.
  const count =
    typeof b.count === "number" ? b.count : required.length + optional.length;
  if (required.length === 0 && optional.length === 0 && count === 0) return undefined;
  return {
    role: typeof b.role === "string" ? b.role : "",
    runId: typeof b.runId === "string" ? b.runId : "",
    bindingPath: typeof b.bindingPath === "string" ? b.bindingPath : "",
    packetPath: typeof b.packetPath === "string" ? b.packetPath : "",
    boundRoot: typeof b.boundRoot === "string" ? b.boundRoot : "",
    required,
    optional,
    count,
  };
}

export interface SourceTone {
  cls: string;   // a .skill-src-* tone class (paired with the label, never colour-alone)
  label: string; // sentence-case source label
}

// Source chip tone: builtin = neutral/--muted, project = --blue, path = --violet,
// anything else = neutral/--muted. Always pairs a tone class with a readable label.
export function sourceTone(source: string): SourceTone {
  switch (source) {
    case "builtin":
      return { cls: "skill-src-builtin", label: "Builtin" };
    case "project":
      return { cls: "skill-src-project", label: "Project" };
    case "path":
      return { cls: "skill-src-path", label: "Path" };
    default:
      return { cls: "skill-src-builtin", label: source ? source : "—" };
  }
}

// First 12 chars of a content hash (provenance/reproducibility), "" when absent.
export function shortHash(hash?: string): string {
  return typeof hash === "string" ? hash.slice(0, 12) : "";
}

// ── Skill-isolation findings (global-user-skill leak detection) ──────────────
// The harness flags when an agent read a user-global Codex skill (e.g. ~/.codex/skills/…) OUTSIDE
// the harness-managed skill packet. That makes the run less reproducible, so it surfaces as a
// WARNING (never a hard blocker) on agentRuns[].skillIsolationFindings and on the run-focus packet
// (eventStream.globalSkillReferences / diagnosis.failureClasses includes "global_skill_leak").
// See docs/architecture/skill-observability-ui-contract.md.
export interface SkillIsolationFinding {
  kind: string;        // e.g. "global_user_skill_reference"
  severity: string;    // e.g. "warning"
  path: string;        // the referenced global-skill path (may be partial / captured from output)
  snippet: string;     // surrounding context from the child event stream
  lineNumber?: number; // 1-based line in the event stream, when known
}

// These paths/snippets are scraped from raw child-process output (often a PowerShell error frame),
// so they can carry ANSI/VT colour codes (ESC[31;1m …) and stray control chars. Strip them and
// collapse whitespace so the UI renders plain, readable text instead of escape-code garbage. Built
// from escaped strings (no literal control chars in source) so the patterns can't be corrupted.
const ANSI_RE = new RegExp(
  "[\\u001b\\u009b][[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-ntqry=><]",
  "g",
);
const CTRL_RE = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]", "g");
export function cleanLeakText(s: string | undefined): string {
  if (typeof s !== "string") return "";
  return s.replace(ANSI_RE, "").replace(CTRL_RE, "").replace(/\s+/g, " ").trim();
}

// The identifying name for a (cleaned) leak path. Every Codex skill file is named SKILL.md, so the
// useful signal is the CONTAINING folder (e.g. .codex/skills/.system/project-overseer/SKILL.md →
// "project-overseer"), not the leaf. Climbs past a SKILL.<ext> leaf (and dot-prefixed scaffolding
// dirs like ".system") to the real id; otherwise returns the last segment. Trailing separators are
// trimmed first. Falls back to the whole cleaned string when there's no usable segment.
export function leakSkillName(path: string | undefined): string {
  const clean = cleanLeakText(path).replace(/[\\/]+$/, "");
  if (!clean) return "";
  const segs = clean.split(/[\\/]+/).filter(Boolean);
  if (segs.length === 0) return clean;
  const leaf = segs[segs.length - 1];
  if (/^SKILL\.[^\\/]+$/i.test(leaf)) {
    for (let i = segs.length - 2; i >= 0; i -= 1) {
      if (!segs[i].startsWith(".")) return segs[i]; // first non-scaffolding parent
    }
    if (segs.length >= 2) return segs[segs.length - 2]; // only dotted parents → nearest parent
  }
  return leaf;
}

// Normalize an arbitrary array of finding-shaped objects into SkillIsolationFinding[]. Tolerant:
// drops null/non-object entries and entries with neither a path nor a snippet; defaults severity to
// "warning". Used for both run.skillIsolationFindings and focus eventStream.globalSkillReferences.
export function normalizeFindings(raw: unknown): SkillIsolationFinding[] {
  if (!Array.isArray(raw)) return [];
  const out: SkillIsolationFinding[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== "object") continue;
    const f = item as Record<string, unknown>;
    if (typeof f.path !== "string" && typeof f.snippet !== "string") continue;
    out.push({
      kind: typeof f.kind === "string" ? f.kind : "",
      severity: typeof f.severity === "string" ? f.severity : "warning",
      path: typeof f.path === "string" ? f.path : "",
      snippet: typeof f.snippet === "string" ? f.snippet : "",
      lineNumber: typeof f.lineNumber === "number" ? f.lineNumber : undefined,
    });
  }
  return out;
}

// Tolerant runtime accessor for run.skillIsolationFindings (declared loosely on the shared type).
// Returns [] when absent/malformed → neutral (no warning), never an error.
export function isolationFindingsOf(run: unknown): SkillIsolationFinding[] {
  if (run == null || typeof run !== "object") return [];
  return normalizeFindings((run as Record<string, unknown>).skillIsolationFindings);
}

// De-duplicate findings by cleaned path + lineNumber (the same global-skill reference can recur
// across an actor's runs / repeated event lines). Order-preserving.
export function dedupeFindings(findings: SkillIsolationFinding[]): SkillIsolationFinding[] {
  const seen = new Set<string>();
  const out: SkillIsolationFinding[] = [];
  for (const f of findings) {
    const key = `${cleanLeakText(f.path)}|${f.lineNumber ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}
