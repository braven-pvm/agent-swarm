// ── Skill Observability (read-only display contract) ─────────────────────────
// The harness binds protocol skills (SKILL.md files) to each agent run and exposes
// the binding additively on snapshot agentRuns[] and on the run-focus packet. These
// shapes are NOT declared on the shared types.ts (user-owned), so the UI reads them
// via safe accessors/casts. Everything here is additive + optional: MANY runs carry
// no skill data (historical / pre-Phase-10D), which is NEUTRAL — never an error.
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

// Safe accessor for run.skills WITHOUT touching the shared AgentRunRecord type.
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
