// SC-1 bounded concurrent dispatcher (with serial fallback) for the live-agent runners.
//
// The live runners (run-live-agent-demo.mjs, run-support-triage-live-demo.mjs) loop one tick at a
// time and dispatch the active slice's worker/reviewer/verify through a BLOCKING execFileSync. That
// serializes wall-clock work even when two INDEPENDENT slices each have a dependency-satisfied next
// mechanical stage (e.g. full-product backend slice + dashboard slice once the backend Depends-On
// refs are accepted). This module adds a NON-BLOCKING dispatch primitive plus a bounded worker pool
// so a tick can fire up to the SC-2 concurrency budget of independent stages concurrently, then let
// each slice advance from ITS OWN ledger evidence on the next observe.
//
// NON-NEGOTIABLES this module preserves:
// - LEDGER-DRIVEN: each spawned child is the SAME leaf CLI command the overseer would have dispatched
//   (`swarm run <id>` / `swarm review <id>`), each writing only its own slice's evidence. No shared
//   mutable cross-slice state is introduced here; the store is the single source of truth.
// - PER-SLICE VERIFY: this pool dispatches ONLY run/review (worker/reviewer). Deterministic verify and
//   the RE-1/RE-2 skeptic gate stay on the untouched serial branch in each runner, gated per slice.
// - BOUNDED + INDEPENDENT: the batch is min(dispatchable, budget) and the dispatchable predicate
//   forbids same-slice pairs and any slice whose Depends-On refs are not all accepted.
// - MINIMAL DISRUPTION: callers only enter the concurrent path when >= 2 slices are dispatchable; with
//   <= 1 they keep the existing serial orchestrate path byte-for-byte.

import { spawn } from "node:child_process";

/**
 * NON-BLOCKING twin of the blocking runSwarm (execFileSync). Spawns the SAME leaf CLI the overseer
 * would have dispatched and resolves with the captured output + exit status. Streams stdout/stderr
 * chunks (no maxBuffer limit, unlike the blocking path) so large observe/run output is never truncated.
 *
 * @param {object} options
 * @param {string} options.nodeExecPath process.execPath
 * @param {string} options.cli absolute path to dist/cli.js
 * @param {string[]} options.commandArgs CLI args after the cli path
 * @param {string} options.cwd working directory for the child
 * @param {NodeJS.ProcessEnv} options.env environment for the child
 * @returns {Promise<{ok:boolean,status:number|null,stdout:string,stderr:string,error?:string}>}
 */
export function runSwarmAsync({ nodeExecPath, cli, commandArgs, cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn(nodeExecPath, [cli, ...commandArgs], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      resolve({
        ok: false,
        status: null,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        error: error instanceof Error ? error.message : String(error),
      });
    });
    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        status: code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

/**
 * Classic bounded worker pool: keep up to `budget` `fn(item)` promises in flight, refill on each
 * settle, await all. Returns the settled results in the SAME order as `items`. `fn` is expected to
 * never reject (runSwarmAsync resolves on error), but rejections are captured defensively so one
 * failing dispatch cannot abort the batch.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} budget max concurrent in-flight
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<Array<{ status: "fulfilled", value: R } | { status: "rejected", reason: unknown }>>}
 */
export async function dispatchPool(items, budget, fn) {
  const results = new Array(items.length);
  const limit = Math.max(1, Math.floor(budget) || 1);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { status: "fulfilled", value: await fn(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

const FRONTEND_PATTERN = /(?:dashboard|frontend|\bui\b|-ui-|web|design|design-system|accessibility)/i;

/**
 * Structured frontend classifier mirroring cli.ts isFrontendTargetOrSlice (target name + slice title
 * + FR/AC refs). Used to derive the dashboard/backend actor convention so concurrent dispatch reuses
 * the EXACT actor names the overseer/compactActionableSlice path would have produced, keeping the
 * final-snapshot agentRuns-by-role accounting unchanged.
 */
export function isFrontendSliceForRunner(slice, target) {
  const haystack = [target?.name, slice.title, ...(slice.frAcRefs ?? [])].filter(Boolean).join(" ").toLowerCase();
  return FRONTEND_PATTERN.test(haystack);
}

/**
 * The next MECHANICAL stage for a slice, restricted to the concurrency-safe envelope:
 * - "run" for status === "ready" only (repairing/blocked are deliberately EXCLUDED so repair-context
 *   senior-judgement slices keep the existing serial/repair path — stricter than the overseer's
 *   compactActionableSlice envelope, which keeps reviewer-repair green).
 * - "review" for status in {implemented, ready_for_review} that are NOT already accepted-review-
 *   pending-verify (those are siphoned by the per-slice verify branch and must never enter the pool).
 * Returns null when no concurrency-safe mechanical stage applies.
 */
export function concurrentNextStage(slice) {
  if (slice.status === "ready") return "run";
  if (slice.status === "implemented") return "review";
  if (slice.status === "ready_for_review") {
    // A ready_for_review slice with an accepted review and no passing command evidence is verify-ready
    // (isReadyForDeterministicVerify) — the serial verify branch owns it; keep it out of the pool.
    const accepted = slice.reviewResult?.status === "accepted";
    const hasPassingCommand = (slice.evidence ?? []).some(
      (item) => item.kind === "command" && item.payload?.passed === true,
    );
    if (accepted && !hasPassingCommand) return null;
    return "review";
  }
  return null;
}

/**
 * Accepted-refs set for the WHOLE snapshot (generalized from inspectDashboardDependencyGate's
 * dashboard-only computation): every FR/AC ref carried by an accepted slice plus every completed
 * lease ref. This is the ledger-driven independence basis — a slice is dependency-satisfied iff all
 * of its own Depends-On refs are in this set.
 */
export function computeAcceptedRefs(snapshot) {
  const acceptedRefs = new Set();
  for (const slice of snapshot.slices) {
    if (slice.status !== "accepted") continue;
    for (const ref of slice.frAcRefs ?? []) acceptedRefs.add(ref);
    for (const lease of slice.leases ?? []) {
      if (lease.status === "completed" && lease.frAcRef) acceptedRefs.add(lease.frAcRef);
    }
  }
  return acceptedRefs;
}

/**
 * Compute the set of slices dispatchable CONCURRENTLY this tick. Pure function of the observe snapshot
 * plus a per-slice Depends-On resolver. Encodes the independence predicate:
 *  1. ACTIVE: status not in {accepted, closed}.
 *  2. HAS A CONCURRENCY-SAFE NEXT STAGE: concurrentNextStage(slice) != null.
 *  3. DEPENDENCY-SATISFIED: every ref in the slice's own Depends-On is in the accepted-refs set.
 *  4. DISTINCT SLICES: deduped by slice.id (a slice's run/review never overlap each other).
 *  5. NO IN-FLIGHT CHILD for that role: skip if an agentRun for the role is already running.
 *
 * @param {object} snapshot observe snapshot ({ slices, targets, ... })
 * @param {(slice: any) => string[]} dependsOnRefsForSlice resolves a slice's declared Depends-On refs
 * @param {(slice: any) => any} targetForSlice resolves the slice's target record (for actor naming)
 * @returns {Array<{ slice:any, stage:"run"|"review", role:"worker"|"reviewer", actor:string }>}
 */
export function computeConcurrentBatch(snapshot, { dependsOnRefsForSlice, targetForSlice }) {
  const acceptedRefs = computeAcceptedRefs(snapshot);
  const seen = new Set();
  const dispatchable = [];
  for (const slice of snapshot.slices) {
    if (["accepted", "closed"].includes(slice.status)) continue;
    if (seen.has(slice.id)) continue;
    const stage = concurrentNextStage(slice);
    if (!stage) continue;
    const dependsOn = dependsOnRefsForSlice(slice) ?? [];
    const satisfied = dependsOn.every((ref) => acceptedRefs.has(ref));
    if (!satisfied) continue;
    const role = stage === "run" ? "worker" : "reviewer";
    const hasInFlight = (slice.agentRuns ?? []).some((run) => run.role === role && run.status === "running");
    if (hasInFlight) continue;
    const target = targetForSlice(slice);
    const isFrontend = isFrontendSliceForRunner(slice, target);
    const actor =
      role === "worker"
        ? isFrontend
          ? "dashboard-worker"
          : "backend-worker"
        : isFrontend
          ? "dashboard-reviewer"
          : "backend-reviewer";
    seen.add(slice.id);
    dispatchable.push({ slice, stage, role, actor });
  }
  return dispatchable;
}

/**
 * Overlap predicate over [startedAt, settledAt] intervals: true iff some two members were BOTH
 * dispatched before EITHER completed (their intervals intersect). spawn yields real OS-level
 * parallelism so these intervals genuinely overlap; a reshuffled-serial implementation could not
 * produce intersecting intervals. This is the load-bearing proof a test asserts.
 */
export function computeOverlap(dispatched) {
  for (let i = 0; i < dispatched.length; i += 1) {
    for (let j = i + 1; j < dispatched.length; j += 1) {
      const a = dispatched[i];
      const b = dispatched[j];
      if (a.startedAt == null || a.settledAt == null || b.startedAt == null || b.settledAt == null) continue;
      if (a.startedAt < b.settledAt && b.startedAt < a.settledAt) return true;
    }
  }
  return false;
}
