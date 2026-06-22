/**
 * Deterministic run-guard skeleton for the swarm control plane.
 *
 * This module is the PLATFORM home for the ledger-derived hard run-limit guards
 * (max runtime / max slices / max agent-runs) and the unconditional
 * source-mutation abort. Both live runners (H1 acceptance-loop / full-product and
 * H2 support-triage) evaluate the SAME deterministic skeleton on every tick.
 *
 * The function is PURE: it performs no fs/store/Date.now access and produces no
 * side-effects. The runner computes the inputs (elapsed time, observed counts,
 * source-mutation signal) and passes plain values IN; the runner applies the
 * decision via its OWN side-effects (finalOutcome/finalReason, escalation,
 * break, turn records). This respects the runners' genuine divergence — only the
 * common, safety-relevant decision logic lives here.
 */

/** The ledger-derived hard limits. Runners pass their OWN defaults (limit-agnostic). */
export interface RunGuardLimits {
  maxRuntimeSeconds: number;
  maxSlices: number;
  maxAgentRuns: number;
}

/**
 * Per-tick inputs. All plain values — the runner computes them (Date.now,
 * observe, inspectSourceMutations) and passes the results IN.
 */
export interface RunGuardInput {
  /** runner: Math.round((Date.now() - startedAt) / 1000) */
  elapsedSeconds: number;
  /** runner: inspectSourceMutations(before.sources).some((item) => item.mutated) */
  sourceMutated: boolean;
  /** runner: before.slices.length */
  sliceCount: number;
  /** runner: before.agentRuns.length */
  agentRunCount: number;
  limits: RunGuardLimits;
}

export type RunGuardKind = "runtime" | "source-mutation" | "slices" | "agent-runs";
export type RunGuardOutcome = "blocked" | "human_required";

export type RunGuardDecision =
  | { stop: false }
  | { stop: true; kind: RunGuardKind; outcome: RunGuardOutcome; reason: string };

/**
 * Evaluate the deterministic hard run-guards for a single tick.
 *
 * Evaluates in the EXACT order both runners use today and returns on the FIRST
 * tripped guard (mirroring each runner's `break`):
 *
 *   1. runtime          (strict `>`)        -> blocked
 *   2. source-mutation  (unconditional)     -> human_required
 *   3. slices           (strict `>`)        -> blocked
 *   4. agent-runs       (strict `>`)        -> blocked
 *
 * Returning on the first trip in this fixed order preserves the safety property
 * that the source-mutation abort fires before any further work in a tick: the
 * function cannot reach the slices/agent-runs guards without first clearing
 * source-mutation.
 *
 * The three numeric guards' `reason` strings are byte-identical across both
 * runners today, so they are produced here verbatim from the inputs. The
 * source-mutation `reason` DIVERGES per runner ("...live acceptance loop." vs
 * "...H2 live run."), so it is intentionally NOT produced here — the decision
 * carries `reason: ""` and each runner sets its own literal finalReason for that
 * one guard. This keeps the divergent string out of the platform module.
 */
export function evaluateRunGuards(input: RunGuardInput): RunGuardDecision {
  const { elapsedSeconds, sourceMutated, sliceCount, agentRunCount, limits } = input;
  const { maxRuntimeSeconds, maxSlices, maxAgentRuns } = limits;

  if (elapsedSeconds > maxRuntimeSeconds) {
    return {
      stop: true,
      kind: "runtime",
      outcome: "blocked",
      reason: `Max runtime exceeded: ${elapsedSeconds}s > ${maxRuntimeSeconds}s.`,
    };
  }

  if (sourceMutated) {
    return {
      stop: true,
      kind: "source-mutation",
      outcome: "human_required",
      reason: "",
    };
  }

  if (sliceCount > maxSlices) {
    return {
      stop: true,
      kind: "slices",
      outcome: "blocked",
      reason: `Max slices exceeded: ${sliceCount} > ${maxSlices}.`,
    };
  }

  if (agentRunCount > maxAgentRuns) {
    return {
      stop: true,
      kind: "agent-runs",
      outcome: "blocked",
      reason: `Max agent runs exceeded: ${agentRunCount} > ${maxAgentRuns}.`,
    };
  }

  return { stop: false };
}
