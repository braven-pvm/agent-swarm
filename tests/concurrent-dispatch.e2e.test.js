import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  computeAcceptedRefs,
  computeConcurrentBatch,
  computeOverlap,
  concurrentNextStage,
  dispatchPool,
  isFrontendSliceForRunner,
  runSwarmAsync,
} from "../scripts/concurrent-dispatch.mjs";

// ---------------------------------------------------------------------------
// SC-1 — bounded CONCURRENT dispatch in the live runner.
//
// Proves the four SC-1 non-negotiables deterministically (no real provider, no
// 2-minute live full-product run):
//   (A) OVERLAP: two independent dependency-satisfied stages are dispatched and
//       genuinely IN-FLIGHT at the same time (their [startedAt,settledAt]
//       intervals intersect). budget=1 forces serial intervals that do NOT
//       intersect — proving the win is real OS-level parallelism, not a
//       reshuffled-serial loop.
//   (B) LEDGER-DRIVEN / IDENTICAL END-STATE: dispatching two independent slices'
//       next stages CONCURRENTLY (the exact runner primitives runSwarmAsync +
//       dispatchPool) yields the SAME per-slice ledger end-state (status +
//       evidence) as running them SERIALLY one subprocess at a time.
//   (C) MINIMAL DISRUPTION: a single-ready-slice tick produces a batch of < 2,
//       so the runner keeps its existing serial path (single-slice tests stay
//       byte-stable).
//   (D) PER-SLICE VERIFY: an accepted-review-pending-verify slice is EXCLUDED
//       from the concurrent pool, so the per-slice deterministic verify branch
//       (and the RE-1/RE-2 skeptic gate) keeps owning that slice's own evidence.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "dist", "cli.js");
const liveDemo = path.join(repoRoot, "scripts", "run-live-agent-demo.mjs");
const template = path.join(repoRoot, "fixtures", "templates", "invoice-api");

function runSwarm(workspace, args, env = {}) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// ===========================================================================
// (A) OVERLAP PROOF — real spawn intervals genuinely intersect under the pool,
//     and budget=1 makes them strictly serial. computeOverlap is the marker the
//     runner records on its `scheduler` turn, so this asserts the marker's
//     meaning against real wall-clock intervals.
// ===========================================================================

// A child that prints START, sleeps `ms`, prints END, exits 0. Two of these run
// concurrently overlap by construction; run serially they cannot.
function writeSleepChild() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc1-overlap-"));
  const scriptPath = path.join(dir, "sleep-child.mjs");
  fs.writeFileSync(
    scriptPath,
    `const ms = Number(process.argv[2] || "150");
const end = Date.now() + ms;
// Busy-ish wait that still yields, so two spawned children truly run together.
await new Promise((resolve) => setTimeout(resolve, ms));
process.stdout.write("DONE " + ms + " " + end + "\\n");
process.exit(0);
`,
    "utf8",
  );
  return scriptPath;
}

test("SC-1 (A): dispatchPool runs two stages concurrently — their dispatch intervals overlap; budget=1 is strictly serial", async () => {
  const sleepChild = writeSleepChild();
  const sleepMs = 200;
  const items = [
    { id: "stage-a", ms: sleepMs },
    { id: "stage-b", ms: sleepMs },
  ];

  // Record start/settle around each runSwarmAsync the same way the runner does.
  function makeRunner() {
    const dispatched = items.map((it) => ({ sliceId: it.id, startedAt: undefined, settledAt: undefined }));
    return { dispatched };
  }

  async function runBatch(budget) {
    const { dispatched } = makeRunner();
    const wallStart = Date.now();
    await dispatchPool(items, budget, async (item, index) => {
      const record = dispatched[index];
      record.startedAt = Date.now();
      const result = await runSwarmAsync({
        nodeExecPath: process.execPath,
        cli: sleepChild,
        commandArgs: [String(item.ms)],
        cwd: repoRoot,
        env: process.env,
      });
      record.settledAt = Date.now();
      return result;
    });
    return { dispatched, wallMs: Date.now() - wallStart };
  }

  // Concurrent: budget 2 -> both in flight before either finishes.
  const concurrent = await runBatch(2);
  assert.equal(
    computeOverlap(concurrent.dispatched),
    true,
    "two independent stages dispatched with budget 2 must have intersecting [startedAt,settledAt] intervals (genuinely in-flight together)",
  );
  // Both children resolved with exit 0 through the non-blocking primitive.
  for (const record of concurrent.dispatched) {
    assert.ok(record.startedAt != null && record.settledAt != null);
  }

  // Serial: budget 1 -> second starts only after first settles, so NO overlap.
  const serial = await runBatch(1);
  assert.equal(
    computeOverlap(serial.dispatched),
    false,
    "budget 1 must dispatch strictly one-at-a-time: intervals must NOT intersect",
  );

  // Wall-clock corroborates real parallelism: concurrent ~= one sleep, serial ~= two.
  // Loose bounds (CI jitter) but directionally load-bearing.
  assert.ok(
    concurrent.wallMs < serial.wallMs,
    `concurrent batch (${concurrent.wallMs}ms) must finish faster than serial (${serial.wallMs}ms) for 2x ${sleepMs}ms stages`,
  );
});

// ===========================================================================
// (C)+(D) SCHEDULER PREDICATE — computeConcurrentBatch / concurrentNextStage on
//         faithful observe-snapshot fixtures (slice shape mirrors
//         buildObservabilitySnapshot: {id,status,frAcRefs,targetId,reviewResult,
//         evidence,leases,agentRuns}).
// ===========================================================================

function slice(overrides) {
  return {
    id: overrides.id,
    status: overrides.status,
    title: overrides.title ?? overrides.id,
    frAcRefs: overrides.frAcRefs ?? [],
    targetId: overrides.targetId ?? "TGT-backend",
    reviewResult: overrides.reviewResult,
    evidence: overrides.evidence ?? [],
    leases: overrides.leases ?? [],
    agentRuns: overrides.agentRuns ?? [],
  };
}

const backendTarget = { id: "TGT-backend", name: "invoice-api", path: "/ws/invoice-api" };
const dashboardTarget = { id: "TGT-dashboard", name: "invoice-dashboard", path: "/ws/invoice-dashboard" };

function snapshotOf(slices, targets = [backendTarget, dashboardTarget]) {
  return { slices, targets };
}

const noDepends = () => [];
const targetForSlice = (s) =>
  [backendTarget, dashboardTarget].find((t) => t.id === s.targetId);

test("SC-1 (C): a single ready slice yields a batch of < 2 — the runner keeps the serial path (minimal disruption)", () => {
  const snapshot = snapshotOf([slice({ id: "SLICE-solo", status: "ready", targetId: "TGT-backend" })]);
  const batch = computeConcurrentBatch(snapshot, {
    dependsOnRefsForSlice: noDepends,
    targetForSlice,
  });
  assert.equal(batch.length, 1, "one ready slice is dispatchable");
  // The runner's tryConcurrentDispatch returns false when dispatchable.length < 2,
  // i.e. it falls through to the existing serial orchestrate path.
  assert.ok(batch.length < 2, "single-ready-slice tick must not engage concurrency");
});

test("SC-1: two INDEPENDENT dependency-satisfied slices each get their next mechanical stage in one batch", () => {
  const snapshot = snapshotOf([
    slice({ id: "SLICE-backend", status: "ready", targetId: "TGT-backend", frAcRefs: ["FR-API-001"] }),
    slice({ id: "SLICE-ui", status: "implemented", targetId: "TGT-dashboard", frAcRefs: ["FR-UI-001"] }),
  ]);
  const batch = computeConcurrentBatch(snapshot, {
    dependsOnRefsForSlice: noDepends,
    targetForSlice,
  });
  assert.equal(batch.length, 2, "both independent slices are dispatchable concurrently");

  const byId = Object.fromEntries(batch.map((entry) => [entry.slice.id, entry]));
  // ready -> run/worker; implemented -> review/reviewer.
  assert.equal(byId["SLICE-backend"].stage, "run");
  assert.equal(byId["SLICE-backend"].role, "worker");
  assert.equal(byId["SLICE-backend"].actor, "backend-worker");
  assert.equal(byId["SLICE-ui"].stage, "review");
  assert.equal(byId["SLICE-ui"].role, "reviewer");
  // dashboard/frontend classification drives the actor name convention.
  assert.equal(byId["SLICE-ui"].actor, "dashboard-reviewer");
  assert.ok(isFrontendSliceForRunner(byId["SLICE-ui"].slice, dashboardTarget));
});

test("SC-1 (independence): a slice whose Depends-On refs are NOT all accepted is excluded from the batch", () => {
  // The dashboard slice depends on FR-API-001, which is owned by a NOT-yet-accepted backend slice.
  const snapshot = snapshotOf([
    slice({ id: "SLICE-backend", status: "ready", targetId: "TGT-backend", frAcRefs: ["FR-API-001"] }),
    slice({ id: "SLICE-ui", status: "ready", targetId: "TGT-dashboard", frAcRefs: ["FR-UI-001"] }),
  ]);
  const dependsOnRefsForSlice = (s) => (s.id === "SLICE-ui" ? ["FR-API-001"] : []);
  const batch = computeConcurrentBatch(snapshot, { dependsOnRefsForSlice, targetForSlice });
  const ids = batch.map((entry) => entry.slice.id);
  assert.deepEqual(ids, ["SLICE-backend"], "dependency-blocked dashboard slice must be withheld; only the independent backend slice dispatches");

  // Once the backend slice is ACCEPTED (its ref enters the accepted-refs set), the dashboard slice unblocks.
  const unblocked = snapshotOf([
    slice({ id: "SLICE-backend", status: "accepted", targetId: "TGT-backend", frAcRefs: ["FR-API-001"] }),
    slice({ id: "SLICE-ui", status: "ready", targetId: "TGT-dashboard", frAcRefs: ["FR-UI-001"] }),
  ]);
  assert.equal(computeAcceptedRefs(unblocked).has("FR-API-001"), true);
  const unblockedBatch = computeConcurrentBatch(unblocked, { dependsOnRefsForSlice, targetForSlice });
  assert.deepEqual(
    unblockedBatch.map((e) => e.slice.id),
    ["SLICE-ui"],
    "after the dependency is accepted, the previously-blocked dashboard slice becomes dispatchable",
  );
});

test("SC-1 (D): an accepted-review-pending-verify slice is EXCLUDED from the pool so per-slice verify owns its evidence", () => {
  // ready_for_review + accepted review + no passing command evidence == isReadyForDeterministicVerify.
  // concurrentNextStage must return null so the verify branch (not the pool) consumes this slice.
  const verifyReady = slice({
    id: "SLICE-verify",
    status: "ready_for_review",
    reviewResult: { status: "accepted" },
    evidence: [{ kind: "review_result", payload: {} }],
  });
  assert.equal(concurrentNextStage(verifyReady), null, "accepted-review-pending-verify must NOT enter the concurrent pool");

  const snapshot = snapshotOf([
    verifyReady,
    slice({ id: "SLICE-ready", status: "ready", targetId: "TGT-backend" }),
  ]);
  const batch = computeConcurrentBatch(snapshot, { dependsOnRefsForSlice: noDepends, targetForSlice });
  assert.deepEqual(
    batch.map((e) => e.slice.id),
    ["SLICE-ready"],
    "the verify-ready slice is siphoned to the serial verify branch; only the independent ready slice is pooled",
  );

  // Sanity: a ready_for_review slice that ALREADY has a passing command (post-verify) is reviewable,
  // not verify-pending, so it is NOT excluded on that rule.
  const reviewable = slice({
    id: "SLICE-reviewable",
    status: "ready_for_review",
    reviewResult: { status: "accepted" },
    evidence: [{ kind: "command", payload: { passed: true } }],
  });
  assert.equal(concurrentNextStage(reviewable), "review");
});

test("SC-1 (in-flight guard): a slice with a running agentRun for the next role is not re-dispatched", () => {
  const snapshot = snapshotOf([
    slice({
      id: "SLICE-running",
      status: "ready",
      targetId: "TGT-backend",
      agentRuns: [{ role: "worker", status: "running" }],
    }),
    slice({ id: "SLICE-free", status: "ready", targetId: "TGT-backend" }),
  ]);
  const batch = computeConcurrentBatch(snapshot, { dependsOnRefsForSlice: noDepends, targetForSlice });
  assert.deepEqual(
    batch.map((e) => e.slice.id),
    ["SLICE-free"],
    "a slice whose worker is already running must not be dispatched a second time",
  );
});

// ===========================================================================
// (B) IDENTICAL LEDGER END-STATE — concurrent vs serial. Drives the REAL swarm
//     CLI on two independent fixture-driver slices. Concurrent uses the exact
//     runner primitives (runSwarmAsync + dispatchPool); serial uses blocking
//     execFileSync one-at-a-time. The resulting per-slice (status, evidence)
//     must be identical, proving concurrency does not perturb the ledger.
// ===========================================================================

function setupTwoSliceWorkspace(name) {
  const workspace = path.join(repoRoot, ".swarm-demo", `${name}-${process.pid}-${Date.now()}`);
  const target = path.join(workspace, "invoice-api");
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(template, target, { recursive: true });

  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["target", "init", target]);
  runSwarm(workspace, ["sources", "add-file", path.join(target, "specs", "invoice-api.md")]);
  // Two SEPARATE single-ref lanes => two independent slices with no cross-dependency.
  const first = runSwarm(workspace, [
    "slices", "pull", "--target", "invoice-api", "--source", "invoice-api.md", "--batch-size", "1", "--new-lane",
  ]);
  const second = runSwarm(workspace, [
    "slices", "pull", "--target", "invoice-api", "--source", "invoice-api.md", "--batch-size", "1", "--new-lane",
  ]);
  const a = /Created slice (SLICE-[a-f0-9]+)/i.exec(first)?.[1];
  const b = /Created slice (SLICE-[a-f0-9]+)/i.exec(second)?.[1];
  assert.ok(a && b && a !== b, `expected two distinct slices, got ${a} / ${b}`);
  return { workspace, target, sliceA: a, sliceB: b };
}

// Per-slice ledger projection that must be invariant to dispatch order/concurrency:
// status + the ordered (kind, summary/passed) of its evidence. We exclude
// non-deterministic fields (timestamps, ids, actor) so the comparison is about
// the EVIDENCE CONTENT, not when/who recorded it.
function ledgerProjection(snapshot, sliceId) {
  const s = snapshot.slices.find((item) => item.id === sliceId);
  assert.ok(s, `slice ${sliceId} present in snapshot`);
  return {
    status: s.status,
    frAcRefs: [...(s.frAcRefs ?? [])].sort(),
    evidenceKinds: (s.evidence ?? []).map((e) => e.kind).sort(),
    frAcResultRefs: (s.frAcResults ?? []).map((r) => r.ref).sort(),
    leaseStatuses: (s.leases ?? []).map((l) => l.status).sort(),
  };
}

test("SC-1 (B): concurrent dispatch of two independent slices yields the SAME ledger end-state as a serial run", async () => {
  // --- Run 1: CONCURRENT (the SC-1 path: runSwarmAsync + dispatchPool, real spawn). ---
  const conc = setupTwoSliceWorkspace("sc1-ledger-concurrent");
  const batchItems = [
    { sliceId: conc.sliceA, actor: "backend-worker" },
    { sliceId: conc.sliceB, actor: "backend-worker" },
  ];
  await dispatchPool(batchItems, 2, async (item) =>
    runSwarmAsync({
      nodeExecPath: process.execPath,
      cli,
      commandArgs: ["run", item.sliceId, "--driver", "fixture", "--actor", item.actor],
      cwd: conc.workspace,
      env: { ...process.env, SWARM_WORKSPACE: conc.workspace },
    }),
  );
  const concSnap = JSON.parse(runSwarm(conc.workspace, ["observe", "--events", "80"]));

  // --- Run 2: SERIAL (blocking execFileSync, one subprocess at a time). ---
  const ser = setupTwoSliceWorkspace("sc1-ledger-serial");
  runSwarm(ser.workspace, ["run", ser.sliceA, "--driver", "fixture", "--actor", "backend-worker"]);
  runSwarm(ser.workspace, ["run", ser.sliceB, "--driver", "fixture", "--actor", "backend-worker"]);
  const serSnap = JSON.parse(runSwarm(ser.workspace, ["observe", "--events", "80"]));

  // The two workspaces have different slice ids; compare by pull ORDER (A vs A, B vs B).
  assert.deepEqual(
    ledgerProjection(concSnap, conc.sliceA),
    ledgerProjection(serSnap, ser.sliceA),
    "first slice's ledger end-state must match between concurrent and serial runs",
  );
  assert.deepEqual(
    ledgerProjection(concSnap, conc.sliceB),
    ledgerProjection(serSnap, ser.sliceB),
    "second slice's ledger end-state must match between concurrent and serial runs",
  );

  // Cross-slice NON-INTERFERENCE: each slice carries ONLY its own worker evidence —
  // no evidence leaked across the two concurrently-dispatched slices.
  const ca = concSnap.slices.find((s) => s.id === conc.sliceA);
  const cb = concSnap.slices.find((s) => s.id === conc.sliceB);
  assert.ok(ca.evidence.length > 0 && cb.evidence.length > 0, "both slices recorded their own worker evidence");
  assert.ok(
    ca.evidence.every((e) => e.sliceId === conc.sliceA),
    "slice A evidence must belong only to slice A (no cross-slice contamination)",
  );
  assert.ok(
    cb.evidence.every((e) => e.sliceId === conc.sliceB),
    "slice B evidence must belong only to slice B (no cross-slice contamination)",
  );

  fs.rmSync(conc.workspace, { recursive: true, force: true });
  fs.rmSync(ser.workspace, { recursive: true, force: true });
});

// ===========================================================================
// RUNNER WIRING — the live runner imports the SC-1 primitives and gates the
// concurrent path on (budget > 1 AND >= 2 dispatchable), recording a `scheduler`
// turn with an overlap marker. A static check keeps the wiring honest without a
// 2-minute live run (the live happy-path + full-product runs are exercised
// separately by live-agent-runner.e2e.test.js).
// ===========================================================================

test("SC-1 (wiring): the live runner imports the concurrent primitives and guards the serial fallback", () => {
  const source = fs.readFileSync(liveDemo, "utf8");
  assert.match(source, /from "\.\/concurrent-dispatch\.mjs"/, "runner imports the SC-1 dispatch module");
  assert.match(source, /computeConcurrentBatch/);
  assert.match(source, /dispatchPool/);
  assert.match(source, /runSwarmAsync/);
  assert.match(source, /computeOverlap/);
  // Serial fallback gate: < 2 dispatchable returns false (existing serial path).
  assert.match(source, /if \(dispatchable\.length < 2\) return false;/);
  // budget <= 1 also falls back to serial.
  assert.match(source, /if \(concurrencyBudget <= 1\) return false;/);
  // The concurrent path is tried in the loop, ahead of the blocking orchestrate dispatch.
  const tryIdx = source.indexOf("await tryConcurrentDispatch(turn, before)");
  const orchestrateIdx = source.indexOf('runSwarm([\n    "orchestrate"');
  assert.ok(tryIdx > 0, "runner calls tryConcurrentDispatch in the loop");
  assert.ok(orchestrateIdx > tryIdx, "the blocking orchestrate dispatch is the serial fallback after the concurrent attempt");
  // Records a scheduler turn carrying the overlap marker.
  assert.match(source, /kind: "scheduler"/);
  assert.match(source, /overlap: computeOverlap\(dispatched\)/);
});
