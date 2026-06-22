import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SwarmStore } from "../dist/storage.js";
import { shouldDispatchSkeptic, skepticDowngradableReasons } from "../scripts/skeptic-auto-dispatch.mjs";

// LAZY AUTO-SKEPTIC wiring proof. The live runners (run-live-agent-demo.mjs / run-support-triage-live-demo.mjs)
// auto-dispatch an INDEPENDENT skeptic BEFORE the deterministic verify ONLY when a slice's accepted review
// still carries a downgradable BLOCKING quality concern and has not been challenged yet — and they decide
// that with shouldDispatchSkeptic (the SAME function imported here, not a copy). RE-1 (skeptic command) and
// RE-2 (the verify gate) are unchanged; this test proves the trigger + the end-to-end accept it enables,
// deterministically via the fixture driver (no provider spend).

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "dist", "cli.js");
const template = path.join(repoRoot, "fixtures", "templates", "invoice-api");
const DIM = "runtime_path";

// ---- pure predicate unit checks (the runner's exact eligibility decision) ----

test("predicate: clean accepted review is NOT skeptic-eligible (laziness / non-disruption)", () => {
  const slice = {
    reviewResult: {
      status: "accepted",
      qualityGate: {
        status: "passed",
        blockingConcerns: [],
        dimensions: [{ dimension: DIM, status: "passed", risk: "none", finding: "ok" }],
      },
    },
    evidence: [],
  };
  assert.deepEqual(skepticDowngradableReasons(slice), []);
  assert.equal(shouldDispatchSkeptic(slice).dispatch, false);
});

test("predicate: failing/high-risk dimension IS eligible; a status=failed or blockingConcern is too", () => {
  const dimSlice = {
    reviewResult: { qualityGate: { status: "passed", blockingConcerns: [], dimensions: [{ dimension: DIM, status: "failed", risk: "high", finding: "bad" }] } },
    evidence: [],
  };
  assert.equal(shouldDispatchSkeptic(dimSlice).dispatch, true);
  assert.match(shouldDispatchSkeptic(dimSlice).reasons[0], new RegExp(`${DIM} failed/high`));

  const statusSlice = { reviewResult: { qualityGate: { status: "failed", blockingConcerns: [], dimensions: [] } }, evidence: [] };
  assert.equal(shouldDispatchSkeptic(statusSlice).dispatch, true);

  const concernSlice = { reviewResult: { qualityGate: { status: "passed", blockingConcerns: ["boom"], dimensions: [] } }, evidence: [] };
  assert.equal(shouldDispatchSkeptic(concernSlice).dispatch, true);
});

test("predicate: already-challenged review is single-shot (alreadyChallenged guard)", () => {
  const slice = {
    reviewResult: { qualityGate: { status: "failed", blockingConcerns: [], dimensions: [] } },
    evidence: [{ kind: "finding_challenge" }],
  };
  // It is downgradable...
  assert.equal(skepticDowngradableReasons(slice).length, 1);
  // ...but a challenge already exists, so the runner does NOT re-dispatch.
  assert.equal(shouldDispatchSkeptic(slice).dispatch, false);
});

// ---- end-to-end: eligible slice -> skeptic command -> verify downgrades (mirrors the runner's sequence) ----

test("end-to-end: an eligible accepted+failing-dimension review auto-dispatches a refuting skeptic -> accepts", () => {
  const { workspace, sliceId } = setupWorkspace("auto-skeptic-downgrade");
  runSwarm(workspace, ["run", sliceId, "--driver", "fixture", "--actor", "as-worker"]);
  runSwarm(workspace, ["review", sliceId, "--driver", "fixture", "--actor", "as-reviewer"]);
  seedFailingQualityReview(workspace, sliceId, sliceFrAcRefs(workspace, sliceId));

  // The runner reads this exact snapshot slice shape and decides eligibility with shouldDispatchSkeptic.
  const eligibleSlice = observeSlice(workspace, sliceId);
  const decision = shouldDispatchSkeptic(eligibleSlice);
  assert.equal(decision.dispatch, true, "a readyForVerify slice with a failing quality dimension must be eligible");

  // Runner step 1: dispatch an INDEPENDENT skeptic via the run driver. Distinct actor (live-skeptic-${turn}
  // shape) -> the CLI independence guard accepts it. Seed a refuting fixture verdict (the refuting-seam path).
  const seedPath = writeSkepticSeed(workspace, [
    { source: "quality_dimension", dimension: DIM, verdict: "refuted", severity: "minor", reasoning: "auto-skeptic disproved." },
  ]);
  runSwarm(workspace, ["skeptic", sliceId, "--driver", "fixture", "--actor", "live-skeptic-7"], {
    SWARM_FIXTURE_SKEPTIC_RESULT: seedPath,
  });

  // Runner step 2: deterministic verify consults the LATEST finding_challenge and downgrades the dimension.
  const verifyOutput = runSwarm(workspace, ["verify", sliceId, "--actor", "live-deterministic-verifier-7", "--force"]);
  assert.match(verifyOutput, /Verification passed/);

  const snapshot = observeSnapshot(workspace);
  const slice = snapshot.slices.find((item) => item.id === sliceId);
  assert.equal(slice.status, "accepted", "slice accepts after the auto-skeptic refutes the dimension");

  const skepticRun = snapshot.agentRuns.find((run) => run.role === "skeptic" && run.actor === "live-skeptic-7");
  assert.ok(skepticRun, "a role:skeptic agentRun should exist for the independent actor");
  assert.ok(snapshot.recentEvents.some((e) => e.type === "skeptic.started"), "a skeptic.started event should be recorded");

  const challenge = slice.evidence.find((item) => item.kind === "finding_challenge");
  assert.ok(challenge, "a finding_challenge evidence should be recorded");

  const downgrade = snapshot.recentEvents.find((e) => e.type === "review.finding_downgraded");
  assert.ok(downgrade, "a review.finding_downgraded event should be recorded");
  assert.equal(downgrade.payload.dimension, DIM);
  assert.equal(downgrade.payload.skepticVerdict, "refuted");
  assert.equal(downgrade.payload.skepticActor, "live-skeptic-7");

  // After the challenge exists, the runner would NOT re-dispatch on a later turn (single-shot).
  assert.equal(shouldDispatchSkeptic(observeSlice(workspace, sliceId)).dispatch, false);
});

test("end-to-end backstop: a failing FR/AC keeps blocking even with a refuting auto-skeptic", () => {
  const { workspace, sliceId } = setupWorkspace("auto-skeptic-backstop");
  runSwarm(workspace, ["run", sliceId, "--driver", "fixture", "--actor", "asb-worker"]);
  runSwarm(workspace, ["review", sliceId, "--driver", "fixture", "--actor", "asb-reviewer"]);
  const refs = sliceFrAcRefs(workspace, sliceId);
  // Failing FR/AC (hard backstop) PLUS a failing quality dimension. The slice is still skeptic-eligible
  // (downgradable quality concern present), but the FR/AC backstop must keep verify blocking.
  seedFailingQualityReview(workspace, sliceId, refs, {
    reviewResult: {
      frAcFindings: refs.map((ref, i) => ({
        ref,
        status: i === 0 ? "failed" : "passed",
        evidence: [],
        finding: i === 0 ? "Seeded failing FR/AC backstop." : "passing",
      })),
    },
  });

  assert.equal(shouldDispatchSkeptic(observeSlice(workspace, sliceId)).dispatch, true, "still eligible (quality concern present)");

  const seedPath = writeSkepticSeed(workspace, [
    { source: "quality_dimension", dimension: DIM, verdict: "refuted", severity: "minor", reasoning: "disproved quality only." },
  ]);
  runSwarm(workspace, ["skeptic", sliceId, "--driver", "fixture", "--actor", "live-skeptic-3"], {
    SWARM_FIXTURE_SKEPTIC_RESULT: seedPath,
  });

  const out = runVerifyExpectFail(workspace, sliceId, "live-deterministic-verifier-3");
  assert.match(out.combined, /Verification failed/, "the FR/AC backstop must keep verify blocking");
  const snapshot = observeSnapshot(workspace);
  const slice = snapshot.slices.find((item) => item.id === sliceId);
  assert.notEqual(slice.status, "accepted");
  // The auto-skeptic still ran + recorded a challenge, but no backstop was downgraded.
  assert.ok(slice.evidence.some((item) => item.kind === "finding_challenge"), "the skeptic still records a challenge");
});

// ---- helpers (mirrors tests/skeptic-gate-consumption.e2e.test.js) ----

function seedFailingQualityReview(workspace, sliceId, frAcRefs, overrides = {}) {
  const store = new SwarmStore(workspace);
  try {
    const id = `EVID-auto-skeptic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    store.insertEvidence({
      id,
      sliceId,
      kind: "review_result",
      summary: "Auto-skeptic seeded review with a failing quality dimension",
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
      summary: "Seeded skeptic verdict for auto-dispatch test.",
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
  const workspace = path.join(repoRoot, ".swarm-demo", `${name}-${process.pid}-${Date.now()}`);
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

function runVerifyExpectFail(workspace, sliceId, actor) {
  try {
    const stdout = runSwarm(workspace, ["verify", sliceId, "--actor", actor, "--force"]);
    return { failed: false, combined: stdout };
  } catch (err) {
    return { failed: true, combined: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}
