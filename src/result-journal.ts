import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// OCF-3 (CONTESTED, opt-in prototype) — content-addressed worker-RESULT journal.
//
// This module is a RESULT cache, NEVER a criteria cache. It exists ONLY to avoid re-spawning the
// worker leaf when the FULLY-ENUMERATED envelope that determines the worker's output is byte-for-byte
// identical to a previous, schema-VALIDATED run.
//
// Hard safety boundaries (see docs/architecture/core-philosophy.md + the OCF-3 brief):
//   * DEFAULT-OFF. Nothing in this module runs unless executeWorkerRun is explicitly opted in. With the
//     flag off, the worker hot path never imports a key, never reads, never writes — behavior is
//     byte-identical to today.
//   * IMMUTABILITY. The content key is sha256 over an envelope that INCLUDES the exact immutable source
//     hashes registered for the slice scope. ANY change to a source hash, the prompt, the driver, the
//     model, or the result-schema yields a DIFFERENT key -> a MISS -> a real re-spawn. A stale result can
//     NEVER be replayed after any immutable input changed.
//   * RESULT-ONLY, WORKER-LEAF-ONLY. Only the worker implementation RESULT artifact is journaled. Reviewer
//     / skeptic / verify / overseer judgements are evaluative criteria and are NEVER cached.
//   * VALIDATED-ONLY. Only a result that already passed the worker result-schema is stored, and a replay is
//     written through the same shared persist core as a fresh validated result.
//
// SOUNDNESS BOUNDARY (stated plainly, not foundational): replaying a worker RESULT artifact is sound only
// insofar as the worker's effect is captured in that result (fixture / evidence runs) or is paired with
// workspace restoration. For a real, code-mutating worker, replaying the result WITHOUT re-applying the
// workspace changes is the contested limitation. This is a measured prototype, not a claim of foundational
// correctness.

export const RESULT_JOURNAL_DIRNAME = "result-journal";

// Fully-enumerated envelope: every field here is interpolated into the worker's behavior. If two runs
// share this envelope byte-for-byte, the worker would (deterministically, for fixture/evidence drivers)
// produce the same result. Any divergence in any field MUST change the key.
export interface ResultJournalEnvelope {
  // The complete, already-rendered worker prompt. It captures the slice id/title, delivery question,
  // work package, FR/AC scope, scope/out-of-scope, expected evidence, verification requirements, the
  // skill packet, and the repair/settled-facts context — i.e. every slice/ledger field that varies the
  // prompt is already inside this string.
  prompt: string;
  // Worker driver id (fixture/codex/claude/...). A different driver is a different execution mechanism.
  driver: string;
  // Resolved model id, if any.
  model?: string;
  // Canonical JSON of the result-schema the worker must satisfy. A schema change must invalidate.
  resultSchemaJson: string;
  // The registered IMMUTABLE source hashes for the slice scope, with their identity. Carried explicitly
  // (NOT just via the prompt, which only renders title+uri) so a source-spec mutation -> new hash -> MISS.
  sourceHashes: Array<{ uri: string; title?: string; hash?: string }>;
  // Stable skill identities (id + requirement + CONTENT hash) for the harness-managed skill packet. The
  // rendered prompt embeds per-run skill-artifact PATHS that change every spawn; those are excluded from the
  // canonical prompt and the skills' CONTENT identity is carried here instead. A real change to a bound
  // skill file changes its content hash -> different key -> MISS; a mere new runId does not.
  skillIdentities?: Array<{ id: string; requirement: string; hash: string }>;
}

export interface StoredResultMeta {
  driver: string;
  model?: string;
  sliceId?: string;
  storedAt: string;
  // Honest provenance for the soundness boundary: which driver produced the cached result.
  note?: string;
}

interface JournalFileShape {
  key: string;
  meta: StoredResultMeta;
  // The validated result value, exactly as it would be persisted to resultPath.
  result: unknown;
}

// Canonicalize an arbitrary JSON-like value with sorted object keys so logically-identical values hash
// identically regardless of key insertion order. Arrays preserve order (order is semantic).
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort();
    const out: Record<string, unknown> = {};
    for (const key of sortedKeys) out[key] = canonicalize(record[key]);
    return out;
  }
  return value;
}

// computeEnvelopeKey -> sha256 hex over the FULLY-ENUMERATED, canonicalized envelope. Pure; no I/O.
export function computeEnvelopeKey(envelope: ResultJournalEnvelope): string {
  // Sort source hashes by uri (then title) so ordering of registered sources does not affect the key,
  // while any change to a hash value DOES.
  const sortedSources = [...envelope.sourceHashes]
    .map((source) => ({ uri: source.uri, title: source.title ?? null, hash: source.hash ?? null }))
    .sort((a, b) => (a.uri === b.uri ? String(a.title).localeCompare(String(b.title)) : a.uri.localeCompare(b.uri)));
  // Sort skill identities by (id, requirement) so packet ordering does not affect the key, while any
  // change to a skill's content hash DOES.
  const sortedSkills = [...(envelope.skillIdentities ?? [])]
    .map((skill) => ({ id: skill.id, requirement: skill.requirement, hash: skill.hash }))
    .sort((a, b) => (a.id === b.id ? a.requirement.localeCompare(b.requirement) : a.id.localeCompare(b.id)));
  const canonicalEnvelope = canonicalize({
    v: 1,
    prompt: envelope.prompt,
    driver: envelope.driver,
    model: envelope.model ?? null,
    resultSchemaJson: envelope.resultSchemaJson,
    sourceHashes: sortedSources,
    skillIdentities: sortedSkills,
  });
  return createHash("sha256").update(JSON.stringify(canonicalEnvelope)).digest("hex");
}

function journalDir(workspace: string): string {
  return path.join(workspace, ".swarm", RESULT_JOURNAL_DIRNAME);
}

function journalPath(workspace: string, key: string): string {
  return path.join(journalDir(workspace), `${key}.json`);
}

// lookup(key) -> the stored validated result value, or null on a miss / unreadable entry.
export function lookup(workspace: string, key: string): { result: unknown; meta: StoredResultMeta } | null {
  const filePath = journalPath(workspace, key);
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as JournalFileShape;
    if (!parsed || typeof parsed !== "object" || parsed.key !== key) return null;
    return { result: parsed.result, meta: parsed.meta };
  } catch {
    // A corrupt/unparseable journal entry is treated as a MISS — never as a silent replay.
    return null;
  }
}

// store(key, validatedResult, meta) — persists a VALIDATED result under the workspace journal. The caller
// MUST have validated the result against the worker result-schema first; this module does not relax that.
export function store(workspace: string, key: string, validatedResult: unknown, meta: StoredResultMeta): string {
  const dir = journalDir(workspace);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = journalPath(workspace, key);
  const payload: JournalFileShape = { key, meta, result: validatedResult };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return filePath;
}

// resultJournalEnabled — the single opt-in seam. DEFAULT OFF.
//   * env SWARM_RESULT_JOURNAL in {1,true,on,yes} (case-insensitive), OR
//   * protocol setting protocol.protocol.workers.resultJournal === true.
// Any other value (including unset) => false => the hot path is byte-identical to today.
export function resultJournalEnabled(protocolSetting?: unknown): boolean {
  const raw = process.env.SWARM_RESULT_JOURNAL?.trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "on" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no" || raw === "") {
    // An explicit disable via env wins over a protocol opt-in (lets a live E2E force-off).
    if (raw !== undefined && raw !== "") return false;
  }
  return protocolSetting === true;
}
