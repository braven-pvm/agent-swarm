import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SwarmStore } from "../dist/storage.js";
import { shouldDispatchSkeptic } from "../scripts/skeptic-auto-dispatch.mjs";

// RE-1/RE-2 ARE NOW LIVE — end-to-end proof.
//
// Before this slice the independent skeptic (RE-1) was dispatchable but never auto-ran, so the accept gate's
// finding_challenge consumption (RE-2) was dormant in real runs. The live runners now auto-dispatch the
// skeptic BEFORE the deterministic verify. This test reproduces the runner's EXACT decision-then-dispatch
// unit (shouldDispatchSkeptic -> `swarm skeptic --actor live-skeptic-<turn> --driver <driver>` -> `swarm
// verify`) — see scripts/run-live-agent-demo.mjs ~:351-376 and scripts/run-support-triage-live-demo.mjs
// ~:166-191, both of which call the SAME imported predicate — so the proof tracks the real wiring rather than
// a copy. Everything is deterministic via the fixture driver (no provider spend); the refuting verdict is
// seeded through the documented SWARM_FIXTURE_SKEPTIC_RESULT test seam.
//
// Three guarantees, end to end:
//   (1) LIVE:     an accepted review with a refutable HIGH-RISK quality dimension auto-triggers an
//                 independent skeptic that REFUTES it -> the slice that WOULD have blocked on the quality gate
//                 now passes verify and accepts; the finding_challenge evidence + skeptic.* events are present.
//   (2) LAZY:     a clean accepted review does NOT auto-trigger any skeptic (happy path unchanged); verify
//                 still passes with no skeptic run, no finding_challenge, no skeptic events.
//   (3) BACKSTOP: a hard backstop (source mutation) is NEVER downgraded — the auto-skeptic still runs and
//                 records a challenge, but verify stays blocking and the slice does not accept.

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "dist", "cli.js");
const template = path.join(repoRoot, "fixtures", "templates", "invoice-api");
const DIM = "runtime_path";

// ---------------------------------------------------------------------------------------------------------
// Runner auto-dispatch unit (mirrors the byte-for-byte block both live runners run before each verify).
// Returns { dispatched, skepticActor, verifierActor, decision } so tests can assert the trigger fired (or
// did not) AND drove the downstream verify exactly as a real turn would.
// ---------------------------------------------------------------------------------------------------------
function autoSkepticThenVerify(workspace, sliceId, turn, { driver = "fixture", skepticSeedPath } = {}) {
  const slice = observeSlice(workspace, sliceId);
  const decision = shouldDispatchSkeptic(slice);

  let dispatched = false;
  const skepticActor = `live-skeptic-${turn}`;
  if (decision.dispatch) {
    // RE-1: independent skeptic via the run's own driver; live-skeptic-<turn> is distinct from every
    // worker/reviewer/verifier actor, so the CLI independence guard accepts it.
    const env = skepticSeedPath ? { SWARM_FIXTURE_SKEPTIC_RESULT: skepticSeedPath } : {};
    runSwarm(workspace, ["skeptic", sliceId, "--actor", skepticActor, "--driver", driver], env);
    dispatched = true;
  }

  // RE-2: the deterministic verify consults the LATEST finding_challenge to (only) downgrade refuted
  // quality-gate findings; hard backstops remain unconditional.
  const verifierActor = `live-deterministic-verifier-${turn}`;
  const verify = runVerify(workspace, sliceId, verifierActor);
  return { dispatched, skepticActor, verifierActor, decision, verify };
}

// (1) LIVE -------------------------------------------------------------------------------------------------
test("LIVE: auto-dispatched independent skeptic REFUTES a high-risk dimension -> a would-block slice accepts", () => {
  const { workspace, sliceId } = setupWorkspace("auto-run-live");
  runSwarm(workspace, ["run", sliceId, "--driver", "fixture", "--actor", "live-worker-7"]);
  runSwarm(workspace, ["review", sliceId, "--driver", "fixture", "--actor", "live-reviewer-7"]);
  // Accepted review whose only blocker is a HIGH-RISK quality dimension (FR/AC + source backstops all clean).
  seedFailingQualityReview(workspace, sliceId, sliceFrAcRefs(workspace, sliceId));

  // Control: without the auto-skeptic this slice's quality gate would BLOCK verify (RE-2 has nothing to
  // consult). This is the "would have blocked" baseline the live skeptic must overturn.
  const baseline = setupWorkspace("auto-run-live-baseline");
  runSwarm(baseline.workspace, ["run", baseline.sliceId, "--driver", "fixture", "--actor", "bl-worker"]);
  runSwarm(baseline.workspace, ["review", baseline.sliceId, "--driver", "fixture", "--actor", "bl-reviewer"]);
  seedFailingQualityReview(baseline.workspace, baseline.sliceId, sliceFrAcRefs(baseline.workspace, baseline.sliceId));
  const baselineVerify = runVerify(baseline.workspace, baseline.sliceId, "bl-verifier");
  assert.equal(baselineVerify.passed, false, "control: a high-risk quality dimension blocks verify with no skeptic");
  assert.match(baselineVerify.combined, /Verification failed/);

  // Now the real turn: the runner's decision unit must elect to dispatch, refute, and accept.
  const seedPath = writeSkepticSeed(workspace, [
    { source: "quality_dimension", dimension: DIM, verdict: "refuted", severity: "minor", reasoning: "Independently disproved." },
  ]);
  const result = autoSkepticThenVerify(workspace, sliceId, 7, { skepticSeedPath: seedPath });

  assert.equal(result.decision.dispatch, true, "the high-risk dimension makes the slice skeptic-eligible");
  assert.equal(result.dispatched, true, "the runner unit auto-dispatched the independent skeptic");
  assert.equal(result.verify.passed, true, "verify passes once the refuted dimension is downgraded");
  assert.match(result.verify.combined, /Verification passed/);

  const snapshot = observeSnapshot(workspace);
  const slice = snapshot.slices.find((item) => item.id === sliceId);
  assert.equal(slice.status, "accepted", "the would-block slice now accepts end-to-end");

  // RE-1: a role:skeptic agentRun by the INDEPENDENT actor, plus the skeptic lifecycle event.
  const skepticRun = snapshot.agentRuns.find((run) => run.role === "skeptic" && run.actor === result.skepticActor);
  assert.ok(skepticRun, "an independent role:skeptic agentRun exists for live-skeptic-7");
  assert.notEqual(skepticRun.actor, "live-worker-7", "skeptic actor must differ from the worker");
  assert.notEqual(skepticRun.actor, "live-reviewer-7", "skeptic actor must differ from the reviewer");
  assert.ok(snapshot.recentEvents.some((e) => e.type === "skeptic.started"), "a skeptic.started event is recorded");

  // The finding_challenge evidence is recorded by the skeptic role.
  const challenge = slice.evidence.find((item) => item.kind === "finding_challenge");
  assert.ok(challenge, "a finding_challenge evidence is recorded");

  // RE-2: the gate consumed the challenge and downgraded exactly the refuted dimension, attributed to the
  // independent skeptic actor.
  const downgrade = snapshot.recentEvents.find((e) => e.type === "review.finding_downgraded");
  assert.ok(downgrade, "a review.finding_downgraded event is recorded");
  assert.equal(downgrade.payload.dimension, DIM);
  assert.equal(downgrade.payload.skepticVerdict, "refuted");
  assert.equal(downgrade.payload.skepticActor, result.skepticActor);

  // Single-shot: a second turn would NOT re-dispatch now that the challenge exists.
  assert.equal(shouldDispatchSkeptic(observeSlice(workspace, sliceId)).dispatch, false, "single-shot: no re-dispatch after a challenge exists");
});

// (2) LAZY -------------------------------------------------------------------------------------------------
test("LAZY: a clean accepted review does NOT auto-trigger a skeptic (happy path unchanged)", () => {
  const { workspace, sliceId } = setupWorkspace("auto-run-clean");
  runSwarm(workspace, ["run", sliceId, "--driver", "fixture", "--actor", "clean-worker"]);
  // The fixture reviewer emits a clean accepted review (passing quality gate, no blocking concern).
  runSwarm(workspace, ["review", sliceId, "--driver", "fixture", "--actor", "clean-reviewer"]);

  const result = autoSkepticThenVerify(workspace, sliceId, 1);

  assert.equal(result.decision.dispatch, false, "a clean accepted review is NOT skeptic-eligible");
  assert.deepEqual(result.decision.reasons, [], "no downgradable blocking reasons on a clean gate");
  assert.equal(result.dispatched, false, "the runner unit did NOT auto-dispatch a skeptic");
  assert.equal(result.verify.passed, true, "the happy path still verifies");
  assert.match(result.verify.combined, /Verification passed/);

  const snapshot = observeSnapshot(workspace);
  const slice = snapshot.slices.find((item) => item.id === sliceId);
  assert.equal(slice.status, "accepted");
  // No skeptic ran: no role:skeptic agentRun, no finding_challenge, no skeptic.* event.
  assert.equal(snapshot.agentRuns.filter((run) => run.role === "skeptic").length, 0, "no skeptic agentRun on the happy path");
  assert.equal(slice.evidence.filter((item) => item.kind === "finding_challenge").length, 0, "no finding_challenge on the happy path");
  assert.equal(snapshot.recentEvents.filter((e) => String(e.type).startsWith("skeptic.")).length, 0, "no skeptic.* event on the happy path");
});

// (3) BACKSTOP ---------------------------------------------------------------------------------------------
test("BACKSTOP: a source-mutation hard backstop is NEVER downgraded, even when the auto-skeptic refutes", () => {
  const { workspace, sliceId } = setupWorkspace("auto-run-backstop-mutation");
  runSwarm(workspace, ["run", sliceId, "--driver", "fixture", "--actor", "mut-worker"]);
  runSwarm(workspace, ["review", sliceId, "--driver", "fixture", "--actor", "mut-reviewer"]);
  // Accepted review that flags an IMMUTABLE SOURCE MUTATION (a hard backstop) alongside a failing quality
  // dimension. The slice is still skeptic-eligible (the downgradable quality concern is present), so the
  // runner WILL dispatch — but the source-mutation backstop must keep verify blocking unconditionally.
  seedFailingQualityReview(workspace, sliceId, sliceFrAcRefs(workspace, sliceId), {
    reviewResult: { sourceMutationDetected: true },
  });

  // The auto-skeptic refutes the quality dimension AND (maliciously) tries to clear the same review. Source
  // mutation is not even a downgradable verdict source, so this can only ever KEEP blocking.
  const seedPath = writeSkepticSeed(workspace, [
    { source: "quality_dimension", dimension: DIM, verdict: "refuted", severity: "minor", reasoning: "tries to clear quality" },
  ]);
  const result = autoSkepticThenVerify(workspace, sliceId, 3, { skepticSeedPath: seedPath });

  assert.equal(result.decision.dispatch, true, "still eligible (a downgradable quality concern is present)");
  assert.equal(result.dispatched, true, "the auto-skeptic still runs");
  assert.equal(result.verify.passed, false, "the source-mutation backstop keeps verify blocking");
  assert.match(result.verify.combined, /Verification failed/);

  const snapshot = observeSnapshot(workspace);
  const slice = snapshot.slices.find((item) => item.id === sliceId);
  assert.notEqual(slice.status, "accepted", "a source-mutation backstop must never accept");

  // The reviewGate reason names the immutable source mutation, and NOTHING was downgraded.
  const cmd = slice.evidence.filter((item) => item.kind === "command").at(-1);
  assert.match(cmd.payload.reviewGate.reason, /immutable source mutation/, "the gate cites the source-mutation backstop");
  assert.equal(
    snapshot.recentEvents.filter((e) => e.type === "review.finding_downgraded").length,
    0,
    "no review.finding_downgraded event for a hard backstop",
  );
  // The skeptic still recorded its independent challenge (RE-1 ran); the backstop is just non-downgradable.
  assert.ok(slice.evidence.some((item) => item.kind === "finding_challenge"), "the independent skeptic still records its challenge");
});

// ---- helpers (shared shape with tests/skeptic-gate-consumption.e2e.test.js) ------------------------------

function seedFailingQualityReview(workspace, sliceId, frAcRefs, overrides = {}) {
  const store = new SwarmStore(workspace);
  try {
    const id = `EVID-auto-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    store.insertEvidence({
      id,
      sliceId,
      kind: "review_result",
      summary: "Auto-run seeded review with a failing quality dimension",
      payload: {
        reviewResult: {
          status: "accepted",
          summary: "Seeded: FR/AC coverage passes but one quality dimension fails.",
          frAcFindings: frAcRefs.map((ref) => ({ ref, status: "passed", evidence: [], finding: "Seeded passing FR/AC finding." })),
          testAssessment: "Seeded.",
          sourceMutationDetected: false,
          stubOrHardcodeRisk: "none",
          qualityGate: {
            status: "passed",
            summary: "Seeded gate with a single failing dimension.",
            dimensions: [{ dimension: DIM, status: "failed", risk: "high", evidence: [], finding: "Seeded failing runtime_path dimension." }],
            blockingConcerns: [],
            residualRisks: [],
          },
          requiredFixes: [],
          escalations: [],
          recommendation: "Seeded.",
          ...overrides.reviewResult,
        },
      },
      createdAt: new Date().toISOString(),
    });
    store.updateSliceStatus(sliceId, "ready_for_review");
    return id;
  } finally {
    store.close();
  }
}

function writeSkepticSeed(workspace, verdicts) {
  const seedPath = path.join(workspace, `skeptic-seed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(
    seedPath,
    JSON.stringify({
      status: "partially_refuted",
      summary: "Seeded skeptic verdict for auto-run live test.",
      challengedReviewStatus: "accepted",
      findingVerdicts: verdicts,
      recommendation: "Seeded.",
    }),
    "utf8",
  );
  return seedPath;
}

function observeSnapshot(workspace) {
  return JSON.parse(runSwarm(workspace, ["observe", "--events", "200"]));
}

function observeSlice(workspace, sliceId) {
  return observeSnapshot(workspace).slices.find((item) => item.id === sliceId);
}

function sliceFrAcRefs(workspace, sliceId) {
  const slice = observeSlice(workspace, sliceId);
  assert.ok(slice && Array.isArray(slice.frAcRefs) && slice.frAcRefs.length > 0, "slice should have frAcRefs");
  return slice.frAcRefs;
}

function setupWorkspace(name) {
  const workspace = path.join(repoRoot, ".swarm-demo", `${name}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const target = path.join(workspace, "invoice-api");
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(template, target, { recursive: true });

  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["target", "init", target]);
  runSwarm(workspace, ["sources", "add-file", path.join(target, "specs", "invoice-api.md")]);
  const pullOutput = runSwarm(workspace, ["slices", "pull", "--target", "invoice-api", "--source", "invoice-api.md", "--batch-size", "3"]);
  const sliceId = /Created slice (SLICE-[a-f0-9]+)/i.exec(pullOutput)?.[1];
  assert.ok(sliceId);
  return { workspace, target, sliceId };
}

function runSwarm(workspace, args, env = {}) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// The runners verify with `--force` (a diagnostic mode that exits 0 regardless), exactly as both live
// runners do. So pass/fail is read from the gate's own "Verification passed/failed" line in the captured
// output, not from the process exit code. (We still capture stdout+stderr if it ever does throw.)
function runVerify(workspace, sliceId, actor) {
  let combined;
  try {
    combined = runSwarm(workspace, ["verify", sliceId, "--actor", actor, "--force"]);
  } catch (err) {
    combined = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  const passed = /Verification passed/.test(combined) && !/Verification failed/.test(combined);
  return { passed, combined };
}
