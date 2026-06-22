// ── Skeptic / RE-2 downgrade observability (read-only display contract) ──────
// The backend runs an INDEPENDENT skeptic that challenges the reviewer's findings
// (verdict real|refuted|uncertain per finding), and the VERIFIER may DOWNGRADE a
// blocking quality concern to accept on the strength of a skeptic refutation
// (review.finding_downgraded). The downgrade does NOT mutate reviewResult.qualityGate,
// so without this surface an accept that bypassed a blocking gate is invisible.
//
// These shapes live on loose HarnessEvent.payload / EvidenceRecord.payload fields
// (declared additively/optionally in types.ts), so we read them through tolerant
// guards: absent/malformed values render NEUTRAL (empty array), never an error.
// The canonical source is src/cli.ts (review.finding_downgraded :1076,
// skeptic.finding_challenged :3596, finding_challenge evidence :3536).

import type { HarnessEvent, EvidenceRecord, SkepticVerdict } from "~/lib/types";

/**
 * A single quality-gate override the verifier applied because an independent skeptic refuted a
 * blocking reviewer concern. Flattened + cleaned from a review.finding_downgraded event payload.
 */
export interface FindingDowngrade {
  /** Human-readable WHAT: the concern text, else the dimension key, else a generic fallback. */
  label: string;
  targetKind?: "dimension" | "concern" | "status";
  /** The severity the concern carried BEFORE the override (e.g. "blocker"). */
  fromSeverity?: string;
  /** The skeptic's stance that justified the override. */
  skepticVerdict?: SkepticVerdict;
  /** WHY: the skeptic's reasoning. */
  reasoning?: string;
  /** WHO: the independent skeptic actor that overrode the concern. */
  skepticActor?: string;
}

/** A single per-finding skeptic verdict (from a skeptic.finding_challenged event or evidence verdict). */
export interface ChallengedVerdict {
  ref?: string;
  dimension?: string;
  source?: string;
  verdict?: SkepticVerdict;
  severity?: string;
  reasoning?: string;
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function payloadOf(ev: HarnessEvent): Record<string, unknown> {
  const p = (ev as { payload?: unknown }).payload;
  return p != null && typeof p === "object" ? (p as Record<string, unknown>) : {};
}

/**
 * Collect every review.finding_downgraded for a slice, NEWEST-FIRST. Each row carries who/what/why.
 * Tolerant: a missing/malformed payload yields a row with a generic label (never throws); a
 * non-array `events` yields []. Returns [] when the slice has no downgrades (neutral — no callout).
 */
export function downgradesForSlice(events: HarnessEvent[], sliceId: string): FindingDowngrade[] {
  if (!Array.isArray(events)) return [];
  const out: FindingDowngrade[] = [];
  for (const ev of events) {
    if (ev.type !== "review.finding_downgraded" || ev.entityId !== sliceId) continue;
    const p = payloadOf(ev);
    const concern = asStr(p.concern);
    const dimension = asStr(p.dimension);
    out.push({
      label: concern ?? dimension ?? "a blocking concern",
      targetKind: asStr(p.targetKind) as FindingDowngrade["targetKind"],
      fromSeverity: asStr(p.fromSeverity),
      skepticVerdict: asStr(p.skepticVerdict) as SkepticVerdict | undefined,
      reasoning: asStr(p.reasoning),
      skepticActor: asStr(p.skepticActor),
    });
  }
  return out.reverse(); // newest-first
}

/**
 * Per-finding skeptic verdicts for a run. Prefers the skeptic.finding_challenged events keyed by
 * runId (richest, one per verdict, IN ORDER); falls back to the finding_challenge evidence's
 * skepticResult.findingVerdicts when no per-verdict events are present. Tolerant: [] on no match.
 */
export function challengedVerdictsOf(
  events: HarnessEvent[],
  runId: string,
  evidence?: EvidenceRecord[],
): ChallengedVerdict[] {
  const fromEvents: ChallengedVerdict[] = [];
  if (Array.isArray(events)) {
    for (const ev of events) {
      if (ev.type !== "skeptic.finding_challenged") continue;
      const p = payloadOf(ev);
      if (asStr(p.runId) !== runId) continue;
      fromEvents.push({
        ref: asStr(p.ref),
        dimension: asStr(p.dimension),
        source: asStr(p.source),
        verdict: asStr(p.verdict) as SkepticVerdict | undefined,
        severity: asStr(p.severity),
        reasoning: asStr(p.reasoning),
      });
    }
  }
  if (fromEvents.length > 0) return fromEvents;
  // Fallback: pull verdicts off the finding_challenge evidence record (no runId on evidence, so
  // we take the first challenge record — there is one skeptic run per review).
  if (Array.isArray(evidence)) {
    for (const e of evidence) {
      if (e.kind !== "finding_challenge") continue;
      const p = e.payload != null && typeof e.payload === "object" ? (e.payload as Record<string, unknown>) : {};
      const result = p.skepticResult;
      const verdicts = result != null && typeof result === "object" ? (result as Record<string, unknown>).findingVerdicts : undefined;
      if (!Array.isArray(verdicts)) continue;
      return verdicts
        .filter((v): v is Record<string, unknown> => v != null && typeof v === "object")
        .map((v) => ({
          ref: asStr(v.ref),
          dimension: asStr(v.dimension),
          source: asStr(v.source),
          verdict: asStr(v.verdict) as SkepticVerdict | undefined,
          severity: asStr(v.severity),
          reasoning: asStr(v.reasoning),
        }));
    }
  }
  return [];
}

export interface VerdictTone {
  cls: string;   // a .sk-verdict-* tone class (always paired with the glyph + label, never colour-alone)
  glyph: string;
  label: string;
}

// Verdict tone: real = the concern STANDS (red, ✕), refuted = the challenge OVERTURNED it
// (green, ✓), uncertain/unknown = neutral amber (?). Colour is always carried alongside a glyph.
export function verdictTone(verdict: SkepticVerdict | undefined): VerdictTone {
  switch (verdict) {
    case "real":
      return { cls: "sk-verdict-real", glyph: "✕", label: "Real" };
    case "refuted":
      return { cls: "sk-verdict-refuted", glyph: "✓", label: "Refuted" };
    default:
      return { cls: "sk-verdict-uncertain", glyph: "?", label: "Uncertain" };
  }
}

export function severityLabel(severity: string | undefined): string {
  return asStr(severity) ?? "";
}
