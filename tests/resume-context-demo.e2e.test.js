import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("resume context demo produces role-specific packets and latest-only checkpoints", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-resume-context-${process.pid}`);
  const output = execFileSync(process.execPath, [
    path.join(repoRoot, "scripts", "run-resume-context-demo.mjs"),
    "--driver",
    "fixture",
    "--workspace",
    workspace,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const summary = JSON.parse(output);

  assert.equal(summary.driver, "fixture");
  assert.match(summary.selected.dashboardSliceId, /^SLICE-/);
  assert.match(summary.selected.dashboardLaneId, /^LANE-/);
  assert.match(summary.selected.dashboardRunId, /^RUN-/);
  assert.match(summary.selected.workerCheckpointId, /^CHK-/);
  assert.ok(summary.counts.checkpoints >= 4);
  assert.equal(summary.counts.workerCheckpointsForSlice, 1);
  assert.deepEqual(summary.resumeAssertions, {
    observeIncludesCheckpoints: true,
    latestOnlyWorkerCheckpoint: true,
    checkpointListMentionsRoles: true,
    checkpointShowHasPayload: true,
    workerPacketHasWorkerFocus: true,
    workerPacketHasGuardrails: true,
    workerPacketHasFrAcScope: true,
    workerPacketHasEvidenceStatus: true,
    verifierPacketHasChecklist: true,
    reviewerPacketHasDriftChecks: true,
    plannerPacketHasPlannerFocus: true,
    overseerPacketHasPlannerFocus: true,
    recoveryPacketHasRecommendation: true,
    recoveryPacketHasArtifacts: true,
  });

  const workerPacket = fs.readFileSync(summary.artifacts.workerPacket, "utf8");
  assert.match(workerPacket, /Resume Packet: worker slice:/);
  assert.match(workerPacket, /Delivery Question/);
  assert.match(workerPacket, /AC-UI-INV-001\.1/);
  assert.match(workerPacket, /Do not accept work without per-FR\/AC evidence/);

  const verifierPacket = fs.readFileSync(summary.artifacts.verifierPacket, "utf8");
  assert.match(verifierPacket, /Verifier Focus/);
  assert.match(verifierPacket, /Block acceptance unless every in-scope FR\/AC/);

  const plannerPacket = fs.readFileSync(summary.artifacts.plannerPacket, "utf8");
  assert.match(plannerPacket, /Planner \/ Overseer Focus/);
  assert.match(plannerPacket, /Active slices/);

  const recoveryPacket = fs.readFileSync(summary.artifacts.recoveryPacket, "utf8");
  assert.match(recoveryPacket, /Recovery Focus/);
  assert.match(recoveryPacket, /No recovery action required|Revive same Codex session|restart task/);

  const checkpointShow = fs.readFileSync(summary.artifacts.checkpointShow, "utf8");
  assert.match(checkpointShow, /"frAcRefs"/);
  assert.match(checkpointShow, /"evidenceStatus"/);
});
