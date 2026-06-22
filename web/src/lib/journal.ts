// ── Worker result-journal replay observability (read-only display contract) ──
// When the OPT-IN result journal is enabled (protocol workers.resultJournal /
// SWARM_RESULT_JOURNAL — default OFF), a worker leaf whose result was previously
// validated is REPLAYED from the journal instead of re-spawning a fresh worker.
// The backend emits a worker.journal_hit event (src/cli.ts:2717) for that run.
//
// A human must be able to see that a leaf was replayed, not freshly produced, and
// the soundness boundary that carries (a result replay does NOT re-apply a
// code-mutating worker's workspace effect — the OCF-3 contested boundary). This
// reader flattens that event into a small descriptor for the run-card "replayed"
// badge. When the journal is off NO worker.journal_hit fires, so the badge is
// inert and default workspaces see NOTHING new.
//
// Shapes live on loose HarnessEvent.payload fields (declared additively/optionally
// in types.ts as WorkerJournalHitPayload), so we read them through tolerant guards:
// absent/malformed values yield undefined (neutral — no badge), never an error.

import type { HarnessEvent } from "~/lib/types";

/**
 * A flattened worker.journal_hit — the worker leaf was REPLAYED from the result journal, not
 * freshly spawned. Carries the provenance (which driver stored it, when) + the honest soundness
 * boundary so the run-card badge tooltip can answer "replayed from what, and is that sound?".
 */
export interface JournalReplay {
  /** The journal key the stored result was keyed under (the replay's identity). */
  journalKey?: string;
  /** ISO timestamp the replayed result was originally stored. */
  storedAt?: string;
  /** The driver that produced + stored the result being replayed. */
  storedDriver?: string;
  /** The honest soundness boundary of replaying (re-applies the RESULT only, not workspace effects). */
  soundnessNote?: string;
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function payloadOf(ev: HarnessEvent): Record<string, unknown> {
  const p = (ev as { payload?: unknown }).payload;
  return p != null && typeof p === "object" ? (p as Record<string, unknown>) : {};
}

/**
 * The journal replay for a specific run, or undefined when that run was freshly spawned (the norm).
 * Matches a worker.journal_hit event by its payload.runId. Tolerant: a non-array `events`, an absent
 * hit, or a malformed payload all yield undefined → the caller renders NOTHING (default-off safe).
 * When several hits share a runId (should not happen) the FIRST match wins.
 */
export function journalReplayForRun(events: HarnessEvent[], runId: string): JournalReplay | undefined {
  if (!Array.isArray(events) || !runId) return undefined;
  for (const ev of events) {
    if (ev.type !== "worker.journal_hit") continue;
    const p = payloadOf(ev);
    if (asStr(p.runId) !== runId) continue;
    return {
      journalKey: asStr(p.journalKey),
      storedAt: asStr(p.storedAt),
      storedDriver: asStr(p.storedDriver),
      soundnessNote: asStr(p.soundnessNote),
    };
  }
  return undefined;
}

/**
 * Does ANY of these runs (by id) have a journal replay among the events? Powers the at-a-glance
 * roster badge. Tolerant: returns false on a non-array input or no match (default-off → no badge).
 */
export function anyJournalReplay(events: HarnessEvent[], runIds: Iterable<string>): boolean {
  if (!Array.isArray(events)) return false;
  const ids = new Set<string>();
  for (const id of runIds) if (id) ids.add(id);
  if (ids.size === 0) return false;
  for (const ev of events) {
    if (ev.type !== "worker.journal_hit") continue;
    const rid = asStr(payloadOf(ev).runId);
    if (rid && ids.has(rid)) return true;
  }
  return false;
}

/** Compose the run-card badge tooltip from a replay descriptor — who stored it, when, + the caveat. */
export function journalReplayTitle(replay: JournalReplay): string {
  const parts: string[] = ["Replayed from the result journal — not freshly spawned."];
  if (replay.storedDriver) parts.push(`Stored by ${replay.storedDriver}.`);
  if (replay.storedAt) parts.push(`Stored at ${replay.storedAt}.`);
  if (replay.soundnessNote) parts.push(replay.soundnessNote);
  return parts.join(" ");
}
