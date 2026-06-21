import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SwarmStore } from "../dist/storage.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "dist", "cli.js");
const template = path.join(repoRoot, "fixtures", "templates", "invoice-api");

// RE-2: the quality gate consumes the LATEST INDEPENDENT finding_challenge (skeptic) evidence to downgrade
// ONLY quality-gate findings the skeptic explicitly REFUTED. Hard backstops stay unconditional; the
// no-skeptic path is byte-identical; every downgrade is recorded (residualRisk line + event).
//
// All deterministic, no provider spend: a failing qualityGate dimension is seeded as a fresh review_result
// directly via the dist store; the skeptic runs through the REAL fixture path + REAL independence guard +
// REAL recording, seeded with a verdict via SWARM_FIXTURE_SKEPTIC_RESULT.

const DIM = "runtime_path";

// Seed a fresh review_result that is "accepted" (so non-quality backstops pass) BUT carries one
// failing/high-risk qualityGate dimension so reviewQualityBlockingReasons would block. All FR/AC findings
// are marked "passed" so the FR/AC coverage backstop does not fire.
function seedFailingQualityReview(workspace, sliceId, frAcRefs, overrides = {}) {
  const store = new SwarmStore(workspace);
  try {
    const id = `EVID-re2-review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    store.insertEvidence({
      id,
      sliceId,
      kind: "review_result",
      summary: "RE-2 seeded review with a failing quality dimension",
      payload: {
        reviewResult: {
          status: "accepted",
          summary: "Seeded: FR/AC coverage passes but one quality dimension fails.",
          frAcFindings: frAcRefs.map((ref) => ({
            ref,
            status: "passed",
            evidence: [],
            finding: "Seeded passing FR/AC finding.",
          })),
          testAssessment: "Seeded.",
          sourceMutationDetected: false,
          stubOrHardcodeRisk: "none",
          qualityGate: {
            status: "passed",
            summary: "Seeded gate with a single failing dimension.",
            dimensions: [
              {
                dimension: DIM,
                status: "failed",
                risk: "high",
                evidence: [],
                finding: "Seeded failing runtime_path dimension.",
              },
            ],
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
    // Ensure verify can run.
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
      summary: "Seeded skeptic verdict for RE-2 gate consumption test.",
      challengedReviewStatus: "accepted",
      findingVerdicts: verdicts,
      recommendation: "Seeded.",
    }),
    "utf8",
  );
  return seedPath;
}

test("(a) DOWNGRADE: independent skeptic refutes a failing quality dimension -> slice accepts; recorded", () => {
  const { workspace, sliceId } = setupWorkspace("re2-downgrade");
  runSwarm(workspace, ["run", sliceId, "--driver", "fixture", "--actor", "re2-worker-a"]);
  runSwarm(workspace, ["review", sliceId, "--driver", "fixture", "--actor", "re2-reviewer-a"]);

  const frAcRefs = sliceFrAcRefs(workspace, sliceId);
  seedFailingQualityReview(workspace, sliceId, frAcRefs);

  const seedPath = writeSkepticSeed(workspace, [
    { source: "quality_dimension", dimension: DIM, verdict: "refuted", severity: "minor", reasoning: "Independently disproved." },
  ]);
  runSwarm(workspace, ["skeptic", sliceId, "--driver", "fixture", "--actor", "re2-skeptic-a"], {
    SWARM_FIXTURE_SKEPTIC_RESULT: seedPath,
  });

  const verifyOutput = runSwarm(workspace, ["verify", sliceId, "--actor", "re2-verifier-a"]);
  assert.match(verifyOutput, /Verification passed/);

  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "200"]));
  const slice = snapshot.slices.find((item) => item.id === sliceId);
  assert.equal(slice.status, "accepted", "slice should accept after the refuted dimension is downgraded");

  const downgradeEvent = snapshot.recentEvents.find((e) => e.type === "review.finding_downgraded");
  assert.ok(downgradeEvent, "expected a review.finding_downgraded event");
  assert.equal(downgradeEvent.payload.dimension, DIM);
  assert.equal(downgradeEvent.payload.skepticVerdict, "refuted");
  assert.equal(downgradeEvent.payload.skepticActor, "re2-skeptic-a");

  const commandEvidence = slice.evidence.filter((item) => item.kind === "command").at(-1);
  assert.ok(commandEvidence.payload.reviewGate.passed, "reviewGate should pass after downgrade");
  assert.ok(
    Array.isArray(commandEvidence.payload.reviewGate.downgrades) && commandEvidence.payload.reviewGate.downgrades.length === 1,
    "reviewGate.downgrades should record the one downgrade",
  );
  assert.equal(commandEvidence.payload.reviewGate.downgrades[0].target, DIM);
  assert.ok(
    commandEvidence.payload.reviewGateResidualRisks.some((line) => line.includes("DOWNGRADED") && line.includes(DIM)),
    "reviewGateResidualRisks should carry a human-readable downgrade line",
  );
});

test("(b) BACKSTOP: skeptic cannot downgrade source-mutation, non-accepted status, or failed FR/AC", () => {
  // (b.i) source mutation
  {
    const { workspace, sliceId } = setupWorkspace("re2-backstop-mutation");
    runSwarm(workspace, ["run", sliceId, "--driver", "fixture", "--actor", "re2-w-mut"]);
    runSwarm(workspace, ["review", sliceId, "--driver", "fixture", "--actor", "re2-r-mut"]);
    const frAcRefs = sliceFrAcRefs(workspace, sliceId);
    seedFailingQualityReview(workspace, sliceId, frAcRefs, {
      reviewResult: { sourceMutationDetected: true },
    });
    const seedPath = writeSkepticSeed(workspace, [
      { source: "quality_dimension", dimension: DIM, verdict: "refuted", severity: "minor", reasoning: "try to clear mutation" },
    ]);
    runSwarm(workspace, ["skeptic", sliceId, "--driver", "fixture", "--actor", "re2-s-mut"], {
      SWARM_FIXTURE_SKEPTIC_RESULT: seedPath,
    });
    const out = runVerifyExpectFail(workspace, sliceId, "re2-v-mut");
    assert.match(out.combined, /Verification failed/);
    const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "200"]));
    const slice = snapshot.slices.find((item) => item.id === sliceId);
    const cmd = slice.evidence.filter((item) => item.kind === "command").at(-1);
    assert.match(cmd.payload.reviewGate.reason, /immutable source mutation/);
    assert.equal(
      snapshot.recentEvents.filter((e) => e.type === "review.finding_downgraded").length,
      0,
      "no downgrade event for a source-mutation backstop",
    );
  }

  // (b.ii) failed/missing-evidence FR/AC coverage via a refuted fr_ac_finding verdict (never consulted)
  {
    const { workspace, sliceId } = setupWorkspace("re2-backstop-frac");
    runSwarm(workspace, ["run", sliceId, "--driver", "fixture", "--actor", "re2-w-frac"]);
    runSwarm(workspace, ["review", sliceId, "--driver", "fixture", "--actor", "re2-r-frac"]);
    const frAcRefs = sliceFrAcRefs(workspace, sliceId);
    // Mark the first FR/AC ref as failed -> coverage backstop must hold.
    const failedFindings = frAcRefs.map((ref, i) => ({
      ref,
      status: i === 0 ? "failed" : "passed",
      evidence: [],
      finding: i === 0 ? "Seeded failing FR/AC finding." : "Seeded passing FR/AC finding.",
    }));
    seedFailingQualityReview(workspace, sliceId, frAcRefs, {
      reviewResult: { frAcFindings: failedFindings },
    });
    const seedPath = writeSkepticSeed(workspace, [
      { source: "fr_ac_finding", ref: frAcRefs[0], verdict: "refuted", severity: "minor", reasoning: "try to clear FR/AC" },
      { source: "quality_dimension", dimension: DIM, verdict: "refuted", severity: "minor", reasoning: "also refute dimension" },
    ]);
    runSwarm(workspace, ["skeptic", sliceId, "--driver", "fixture", "--actor", "re2-s-frac"], {
      SWARM_FIXTURE_SKEPTIC_RESULT: seedPath,
    });
    const out = runVerifyExpectFail(workspace, sliceId, "re2-v-frac");
    assert.match(out.combined, /Verification failed/);
    const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "200"]));
    const slice = snapshot.slices.find((item) => item.id === sliceId);
    const cmd = slice.evidence.filter((item) => item.kind === "command").at(-1);
    assert.match(cmd.payload.reviewGate.reason, /non-passing FR\/AC findings/);
    // The fr_ac_finding verdict is NEVER consulted, so no FR/AC downgrade. (The quality_dimension verdict
    // would downgrade the dimension, but the FR/AC backstop is evaluated first and keeps blocking.)
    assert.notEqual(slice.status, "accepted", "FR/AC coverage backstop must keep the slice non-accepted");
  }
});

test("(c) BACKWARD-COMPAT: with NO finding_challenge, the review gate reason is byte-identical", () => {
  // Workspace 1: failing quality dimension, NO skeptic.
  const ws1 = setupWorkspace("re2-bc-noskeptic-1");
  runSwarm(ws1.workspace, ["run", ws1.sliceId, "--driver", "fixture", "--actor", "bc1-w"]);
  runSwarm(ws1.workspace, ["review", ws1.sliceId, "--driver", "fixture", "--actor", "bc1-r"]);
  seedFailingQualityReview(ws1.workspace, ws1.sliceId, sliceFrAcRefs(ws1.workspace, ws1.sliceId));
  runVerifyExpectFail(ws1.workspace, ws1.sliceId, "bc1-v");
  const reason1 = latestCommandReviewGateReason(ws1.workspace, ws1.sliceId);

  // Workspace 2: identical, also NO skeptic.
  const ws2 = setupWorkspace("re2-bc-noskeptic-2");
  runSwarm(ws2.workspace, ["run", ws2.sliceId, "--driver", "fixture", "--actor", "bc2-w"]);
  runSwarm(ws2.workspace, ["review", ws2.sliceId, "--driver", "fixture", "--actor", "bc2-r"]);
  seedFailingQualityReview(ws2.workspace, ws2.sliceId, sliceFrAcRefs(ws2.workspace, ws2.sliceId));
  runVerifyExpectFail(ws2.workspace, ws2.sliceId, "bc2-v");
  const reason2 = latestCommandReviewGateReason(ws2.workspace, ws2.sliceId);

  assert.equal(reason1, reason2, "no-skeptic review gate reason must be byte-identical across runs");
  assert.match(reason1, /latest review quality gate failed/);
  assert.match(reason1, new RegExp(`${DIM} failed/high`));

  // Regression: the accepted-review case still passes with the canonical reason.
  const ws3 = setupWorkspace("re2-bc-accepted");
  runSwarm(ws3.workspace, ["run", ws3.sliceId, "--driver", "fixture", "--actor", "bc3-w"]);
  runSwarm(ws3.workspace, ["review", ws3.sliceId, "--driver", "fixture", "--actor", "bc3-r"]);
  const verifyOut = runSwarm(ws3.workspace, ["verify", ws3.sliceId, "--actor", "bc3-v"]);
  assert.match(verifyOut, /Verification passed/);
  assert.equal(latestCommandReviewGateReason(ws3.workspace, ws3.sliceId), "latest review accepted");
});

test("(d) INDEPENDENCE: a non-independent challenge (skeptic actor == worker) is IGNORED -> still blocks", () => {
  const { workspace, sliceId } = setupWorkspace("re2-independence");
  const sharedActor = "re2-shared-actor";
  runSwarm(workspace, ["run", sliceId, "--driver", "fixture", "--actor", sharedActor]);
  runSwarm(workspace, ["review", sliceId, "--driver", "fixture", "--actor", "re2-ind-reviewer"]);
  const frAcRefs = sliceFrAcRefs(workspace, sliceId);
  const reviewEvidenceId = seedFailingQualityReview(workspace, sliceId, frAcRefs);

  // Directly seed a refuted finding_challenge whose ONLY skeptic agent run reuses the worker actor.
  // (The live guard would reject this actor; we seed directly to prove the gate's defense-in-depth.)
  const store = new SwarmStore(workspace);
  try {
    store.insertAgentRun({
      id: `RUN-re2-ind-${Date.now()}`,
      sliceId,
      role: "skeptic",
      entityType: "slice",
      entityId: sliceId,
      actor: sharedActor, // NOT independent
      driver: "fixture",
      status: "completed",
      attempt: 1,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    store.insertEvidence({
      id: `EVID-re2-ind-challenge-${Date.now()}`,
      sliceId,
      kind: "finding_challenge",
      summary: "Seeded non-independent challenge",
      payload: {
        skepticResult: {
          status: "refuted",
          summary: "non-independent",
          challengedReviewStatus: "accepted",
          findingVerdicts: [
            { source: "quality_dimension", dimension: DIM, verdict: "refuted", severity: "minor", reasoning: "ignored" },
          ],
          recommendation: "x",
        },
        challengedReviewEvidenceId: reviewEvidenceId,
      },
      createdAt: new Date().toISOString(),
    });
  } finally {
    store.close();
  }

  const out = runVerifyExpectFail(workspace, sliceId, "re2-ind-verifier");
  assert.match(out.combined, /Verification failed/);
  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "200"]));
  const slice = snapshot.slices.find((item) => item.id === sliceId);
  assert.notEqual(slice.status, "accepted", "non-independent challenge must NOT downgrade");
  const cmd = slice.evidence.filter((item) => item.kind === "command").at(-1);
  assert.match(cmd.payload.reviewGate.reason, /latest review quality gate failed/);
  assert.equal(
    snapshot.recentEvents.filter((e) => e.type === "review.finding_downgraded").length,
    0,
    "no downgrade event for a non-independent challenge",
  );
});

test("(e) REAL/UNCERTAIN/UNMATCHED verdicts do NOT downgrade -> still blocks", () => {
  const cases = [
    { name: "real", verdicts: [{ source: "quality_dimension", dimension: DIM, verdict: "real", severity: "major", reasoning: "confirmed" }] },
    { name: "uncertain", verdicts: [{ source: "quality_dimension", dimension: DIM, verdict: "uncertain", severity: "minor", reasoning: "unsure" }] },
    {
      name: "unmatched",
      verdicts: [{ source: "quality_dimension", dimension: "some_other", verdict: "refuted", severity: "minor", reasoning: "wrong dimension" }],
    },
  ];
  for (const c of cases) {
    const { workspace, sliceId } = setupWorkspace(`re2-keepblock-${c.name}`);
    runSwarm(workspace, ["run", sliceId, "--driver", "fixture", "--actor", `re2-w-${c.name}`]);
    runSwarm(workspace, ["review", sliceId, "--driver", "fixture", "--actor", `re2-r-${c.name}`]);
    const frAcRefs = sliceFrAcRefs(workspace, sliceId);
    seedFailingQualityReview(workspace, sliceId, frAcRefs);
    const seedPath = writeSkepticSeed(workspace, c.verdicts);
    runSwarm(workspace, ["skeptic", sliceId, "--driver", "fixture", "--actor", `re2-s-${c.name}`], {
      SWARM_FIXTURE_SKEPTIC_RESULT: seedPath,
    });
    const out = runVerifyExpectFail(workspace, sliceId, `re2-v-${c.name}`);
    assert.match(out.combined, /Verification failed/, `case ${c.name} must fail verification`);
    const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "200"]));
    const slice = snapshot.slices.find((item) => item.id === sliceId);
    assert.notEqual(slice.status, "accepted", `case ${c.name} must not accept`);
    const cmd = slice.evidence.filter((item) => item.kind === "command").at(-1);
    assert.match(cmd.payload.reviewGate.reason, new RegExp(`${DIM} failed/high`), `case ${c.name} keeps the quality reason`);
    assert.equal(
      snapshot.recentEvents.filter((e) => e.type === "review.finding_downgraded").length,
      0,
      `case ${c.name} must not emit a downgrade event`,
    );
  }
});

test("(f) DECOUPLING: honest independent challenge present, but the LATEST challenge author is non-independent -> no downgrade", () => {
  const { workspace, sliceId } = setupWorkspace("re2-decouple");
  runSwarm(workspace, ["run", sliceId, "--driver", "fixture", "--actor", "re2-dec-worker"]);
  runSwarm(workspace, ["review", sliceId, "--driver", "fixture", "--actor", "re2-dec-reviewer"]);
  const frAcRefs = sliceFrAcRefs(workspace, sliceId);
  const reviewEvidenceId = seedFailingQualityReview(workspace, sliceId, frAcRefs);

  // An HONEST independent skeptic refutes the dimension (records finding_challenge #1, author independent).
  const seedPath = writeSkepticSeed(workspace, [
    { source: "quality_dimension", dimension: DIM, verdict: "refuted", severity: "minor", reasoning: "honest independent refutation" },
  ]);
  runSwarm(workspace, ["skeptic", sliceId, "--driver", "fixture", "--actor", "re2-dec-skeptic"], {
    SWARM_FIXTURE_SKEPTIC_RESULT: seedPath,
  });

  // ATTACK: seed a LATER finding_challenge authored by the WORKER actor (non-independent), refuting the same
  // dimension + targeting the same review, so it becomes the LATEST challenge the gate reads. The fix binds
  // independence to the CONSUMED challenge's own author, so this must be ignored even though an honest
  // independent challenge exists earlier. (Conservative: a malicious latest challenge can only KEEP blocking.)
  const store = new SwarmStore(workspace);
  try {
    store.insertEvidence({
      id: `EVID-re2-decouple-${Date.now()}`,
      sliceId,
      kind: "finding_challenge",
      summary: "Seeded non-independent LATEST challenge",
      payload: {
        skepticActor: "re2-dec-worker", // the worker actor — NOT independent
        challengedReviewEvidenceId: reviewEvidenceId,
        skepticResult: {
          status: "refuted",
          summary: "attacker",
          challengedReviewStatus: "accepted",
          findingVerdicts: [
            { source: "quality_dimension", dimension: DIM, verdict: "refuted", severity: "minor", reasoning: "attacker refutation" },
          ],
          recommendation: "x",
        },
      },
      createdAt: new Date().toISOString(),
    });
  } finally {
    store.close();
  }

  const out = runVerifyExpectFail(workspace, sliceId, "re2-dec-verifier");
  assert.match(out.combined, /Verification failed/);
  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "200"]));
  const slice = snapshot.slices.find((item) => item.id === sliceId);
  assert.notEqual(slice.status, "accepted", "a non-independent LATEST challenge must not downgrade, even with an honest one present");
  assert.equal(
    snapshot.recentEvents.filter((e) => e.type === "review.finding_downgraded" && e.payload.skepticActor === "re2-dec-worker").length,
    0,
    "no downgrade attributed to the non-independent worker actor",
  );
});

function sliceFrAcRefs(workspace, sliceId) {
  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "5"]));
  const slice = snapshot.slices.find((item) => item.id === sliceId);
  assert.ok(slice && Array.isArray(slice.frAcRefs) && slice.frAcRefs.length > 0, "slice should have frAcRefs");
  return slice.frAcRefs;
}

function latestCommandReviewGateReason(workspace, sliceId) {
  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "5"]));
  const slice = snapshot.slices.find((item) => item.id === sliceId);
  const cmd = slice.evidence.filter((item) => item.kind === "command").at(-1);
  return cmd.payload.reviewGate.reason;
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
  const pullOutput = runSwarm(workspace, [
    "slices",
    "pull",
    "--target",
    "invoice-api",
    "--source",
    "invoice-api.md",
    "--batch-size",
    "3",
  ]);
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

// verify exits non-zero when it fails; capture stdout+stderr regardless.
function runVerifyExpectFail(workspace, sliceId, actor) {
  try {
    const stdout = runSwarm(workspace, ["verify", sliceId, "--actor", actor]);
    return { failed: false, combined: stdout };
  } catch (err) {
    return { failed: true, combined: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}
