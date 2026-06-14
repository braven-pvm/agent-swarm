import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const liveDemo = path.join(repoRoot, "scripts", "run-live-agent-demo.mjs");
const compareLiveRuns = path.join(repoRoot, "scripts", "compare-live-agent-runs.mjs");
const cli = path.join(repoRoot, "dist", "cli.js");

test("live agent runner loops overseer child dispatch through deterministic acceptance", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-live-agent-runner-${process.pid}-${Date.now()}`);
  const fakeCodexScript = writeFakeLiveCodex();

  const output = execFileSync(
    process.execPath,
    [
      liveDemo,
      "--workspace",
      workspace,
      "--driver",
      "codex",
      "--reset",
      "--max-turns",
      "6",
      "--max-runtime-seconds",
      "120",
      "--execute-limit",
      "3",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        SWARM_CODEX_COMMAND: process.execPath,
        SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
        TEST_SWARM_CLI: cli,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const summary = JSON.parse(output);

  assert.equal(summary.workspace, workspace);
  assert.equal(summary.driver, "codex");
  assert.equal(summary.runMode, "live-agent-smoke");
  assert.equal(summary.phase, "phase-5c-autonomous-acceptance-loop");
  assert.equal(summary.finalOutcome, "accepted");
  assert.equal(summary.finalSliceStatus, "accepted");
  assert.equal(summary.outcomeClassification.code, "accepted");
  assert.equal(summary.outcomeClassification.severity, "accepted");
  assert.ok(Object.entries(summary.assertions).every(([, value]) => value === true));
  assert.ok(summary.turns.filter((turn) => turn.kind === "overseer").length >= 3);
  assert.equal(summary.verifyRuns.length, 1);
  assert.equal(summary.verifyRuns[0].accepted, true);
  assert.ok(summary.runs.overseers.length >= 3);
  assert.equal(summary.runs.worker.driver, "codex");
  assert.equal(summary.runs.reviewer.driver, "codex");
  assert.equal(summary.review.status, "accepted");

  for (const artifact of [
    summary.artifacts.summary,
    summary.artifacts.snapshot,
    summary.artifacts.graph,
    summary.artifacts.report,
    summary.artifacts.timeline,
    summary.artifacts.workerResult,
    summary.artifacts.reviewerResult,
    summary.artifacts.verificationOutput,
    summary.artifacts.artifactIndex,
    summary.artifacts.artifactIndexMarkdown,
  ]) {
    assert.ok(fs.existsSync(artifact), `Missing artifact: ${artifact}`);
  }
  const artifactIndex = assertArtifactIndex(summary, "accepted", [
    "summary",
    "snapshot",
    "graph",
    "report",
    "timeline",
    "workerResult",
    "reviewerResult",
    "verificationOutput",
  ]);
  assert.ok(artifactIndex.quickOpen.latestWorkerResult);
  assert.ok(artifactIndex.quickOpen.latestReviewerResult);
  assert.ok(artifactIndex.quickOpen.latestVerificationOutput);

  const snapshot = JSON.parse(fs.readFileSync(summary.artifacts.snapshot, "utf8"));
  const slice = snapshot.slices.find((item) => item.id === summary.sliceId);
  assert.equal(slice.status, "accepted");
  assert.ok(slice.evidence.some((item) => item.kind === "worker_result"));
  assert.ok(slice.evidence.some((item) => item.kind === "review_result"));
  assert.ok(slice.evidence.some((item) => item.kind === "command" && item.payload.passed === true));
  assert.ok(snapshot.recentEvents.some((event) => event.type === "overseer.commands_completed"));
  assert.ok(snapshot.recentEvents.some((event) => event.type === "worker.agent_event"));
  assert.ok(snapshot.recentEvents.some((event) => event.type === "reviewer.agent_event"));
  assert.ok(snapshot.recentEvents.some((event) => event.type === "verification.completed" && event.payload.passed === true));

  const manifest = JSON.parse(fs.readFileSync(path.join(workspace, "live-agent-smoke.json"), "utf8"));
  assert.equal(manifest.runMode, "live-agent-smoke");
  assert.equal(manifest.phase, "phase-5c-autonomous-acceptance-loop");
  assert.equal(manifest.liveRun.finalOutcome, "accepted");
});

test("live agent runner stops visibly when a registered source spec is mutated", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-live-agent-source-mutation-${process.pid}-${Date.now()}`);
  const fakeCodexScript = writeFakeLiveCodex();

  const output = execFileSync(
    process.execPath,
    [
      liveDemo,
      "--workspace",
      workspace,
      "--driver",
      "codex",
      "--reset",
      "--fault",
      "source-mutation",
      "--max-turns",
      "3",
      "--max-runtime-seconds",
      "120",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        SWARM_CODEX_COMMAND: process.execPath,
        SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
        TEST_SWARM_CLI: cli,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const summary = JSON.parse(output);

  assert.equal(summary.workspace, workspace);
  assert.equal(summary.phase, "phase-6-fault-injection");
  assert.equal(summary.fault.mode, "source-mutation");
  assert.equal(summary.finalOutcome, "human_required");
  assert.equal(summary.outcomeClassification.code, "source_mutation");
  assert.equal(summary.outcomeClassification.severity, "human_required");
  assert.match(summary.finalReason, /Immutable source mutation/);
  assert.ok(Object.entries(summary.assertions).every(([, value]) => value === true));
  assert.equal(summary.counts.turns, 0);
  assert.equal(summary.counts.verifyRuns, 0);
  assert.equal(summary.runs.overseers.length, 0);
  assert.ok(summary.sourceMutations.some((item) => item.mutated));
  assertArtifactIndex(summary, "source_mutation", ["summary", "snapshot", "graph", "report", "timeline"]);

  const snapshot = JSON.parse(fs.readFileSync(summary.artifacts.snapshot, "utf8"));
  assert.equal(snapshot.agentRuns.length, 0);
  assert.ok(
    snapshot.activeEscalations.some(
      (item) =>
        item.entityType === "harness" &&
        item.entityId === "scenario:live-agent-smoke" &&
        item.level === "human_required" &&
        item.message.includes("Immutable source mutation"),
    ),
  );
  assert.ok(snapshot.recentEvents.some((event) => event.type === "escalation.created"));

  const manifest = JSON.parse(fs.readFileSync(path.join(workspace, "live-agent-smoke.json"), "utf8"));
  assert.equal(manifest.phase, "phase-6-fault-injection");
  assert.equal(manifest.liveRun.fault, "source-mutation");
  assert.equal(manifest.liveRun.finalOutcome, "human_required");
});

test("live agent runner repairs after reviewer blocks acceptance once", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-live-agent-reviewer-repair-${process.pid}-${Date.now()}`);
  const fakeCodexScript = writeFakeLiveCodex();

  const output = execFileSync(
    process.execPath,
    [
      liveDemo,
      "--workspace",
      workspace,
      "--driver",
      "codex",
      "--reset",
      "--fault",
      "reviewer-repair",
      "--max-turns",
      "8",
      "--max-runtime-seconds",
      "120",
      "--execute-limit",
      "3",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        SWARM_CODEX_COMMAND: process.execPath,
        SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
        TEST_SWARM_CLI: cli,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const summary = JSON.parse(output);

  assert.equal(summary.workspace, workspace);
  assert.equal(summary.phase, "phase-6-fault-injection");
  assert.equal(summary.fault.mode, "reviewer-repair");
  assert.equal(summary.finalOutcome, "accepted");
  assert.equal(summary.finalSliceStatus, "accepted");
  assert.equal(summary.outcomeClassification.code, "accepted");
  assert.ok(Object.entries(summary.assertions).every(([, value]) => value === true));
  assert.ok(summary.runs.workers.length >= 2);
  assert.ok(summary.runs.reviewers.length >= 2);
  assert.ok(summary.repairClearances.length >= 1);
  assert.equal(summary.verifyRuns.length, 1);
  assert.equal(summary.verifyRuns[0].accepted, true);
  assertArtifactIndex(summary, "accepted", ["workerResult", "reviewerResult", "verificationOutput"]);

  const snapshot = JSON.parse(fs.readFileSync(summary.artifacts.snapshot, "utf8"));
  const slice = snapshot.slices.find((item) => item.id === summary.sliceId);
  assert.equal(slice.status, "accepted");
  assert.ok(snapshot.recentEvents.some((event) => event.type === "review.blocked_acceptance"));
  assert.ok(snapshot.recentEvents.some((event) => event.type === "escalation.cleared"));
  assert.ok(snapshot.recentEvents.some((event) => event.type === "verification.completed" && event.payload.passed === true));
  assert.equal(
    snapshot.activeEscalations.filter((item) => item.entityId === summary.sliceId && item.level === "blocker").length,
    0,
  );

  const manifest = JSON.parse(fs.readFileSync(path.join(workspace, "live-agent-smoke.json"), "utf8"));
  assert.equal(manifest.phase, "phase-6-fault-injection");
  assert.equal(manifest.liveRun.fault, "reviewer-repair");
  assert.equal(manifest.liveRun.finalOutcome, "accepted");
});

test("live agent runner recovers a stale worker run through restart", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-live-agent-stale-run-${process.pid}-${Date.now()}`);
  const fakeCodexScript = writeFakeLiveCodex();

  const output = execFileSync(
    process.execPath,
    [
      liveDemo,
      "--workspace",
      workspace,
      "--driver",
      "codex",
      "--reset",
      "--fault",
      "stale-run",
      "--max-turns",
      "8",
      "--max-runtime-seconds",
      "120",
      "--execute-limit",
      "3",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        SWARM_CODEX_COMMAND: process.execPath,
        SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
        TEST_SWARM_CLI: cli,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const summary = JSON.parse(output);

  assert.equal(summary.workspace, workspace);
  assert.equal(summary.phase, "phase-6-fault-injection");
  assert.equal(summary.fault.mode, "stale-run");
  assert.equal(summary.finalOutcome, "accepted");
  assert.equal(summary.finalSliceStatus, "accepted");
  assert.equal(summary.outcomeClassification.code, "accepted");
  assert.ok(Object.entries(summary.assertions).every(([, value]) => value === true));
  assert.ok(summary.turns.some((turn) => turn.kind === "recovery"));
  assert.equal(summary.staleRecovery.staleRunId, "RUN-live-stale-001");
  assert.ok(summary.staleRecovery.injectedAtTurn >= 1);
  assert.ok(summary.staleRecovery.markedAtTurn >= summary.staleRecovery.injectedAtTurn);
  assert.ok(summary.staleRecovery.restartedAtTurn >= summary.staleRecovery.markedAtTurn);
  assert.ok(summary.staleRecoveryClearances.length >= 1);
  assert.equal(summary.verifyRuns.length, 1);
  assert.equal(summary.verifyRuns[0].accepted, true);

  for (const artifact of [
    summary.artifacts.recoveryScan,
    summary.artifacts.recoveryMark,
    summary.artifacts.recoveryRestart,
    summary.artifacts.verificationOutput,
  ]) {
    assert.ok(fs.existsSync(artifact), `Missing artifact: ${artifact}`);
  }
  assertArtifactIndex(summary, "accepted", [
    "recoveryScan",
    "recoveryMark",
    "recoveryRestart",
    "verificationOutput",
  ]);

  const snapshot = JSON.parse(fs.readFileSync(summary.artifacts.snapshot, "utf8"));
  const slice = snapshot.slices.find((item) => item.id === summary.sliceId);
  const staleRun = snapshot.agentRuns.find((item) => item.id === "RUN-live-stale-001");
  assert.equal(slice.status, "accepted");
  assert.equal(staleRun.status, "stale");
  assert.ok(
    snapshot.agentRuns.some(
      (item) => item.id !== staleRun.id && item.sliceId === summary.sliceId && item.role === "worker" && item.status === "completed",
    ),
  );
  assert.ok(snapshot.recentEvents.some((event) => event.type === "recovery.marked_stale_run"));
  assert.ok(snapshot.recentEvents.some((event) => event.type === "recovery.restart_started"));
  assert.ok(snapshot.recentEvents.some((event) => event.type === "recovery.restart_completed"));
  assert.ok(snapshot.recentEvents.some((event) => event.type === "escalation.cleared"));
  assert.ok(snapshot.recentEvents.some((event) => event.type === "verification.completed" && event.payload.passed === true));
  assert.equal(snapshot.activeEscalations.filter((item) => item.message.includes("RUN-live-stale-001")).length, 0);

  const manifest = JSON.parse(fs.readFileSync(path.join(workspace, "live-agent-smoke.json"), "utf8"));
  assert.equal(manifest.phase, "phase-6-fault-injection");
  assert.equal(manifest.liveRun.fault, "stale-run");
  assert.equal(manifest.liveRun.finalOutcome, "accepted");
});

test("live agent runner revives a stalled worker session before restart fallback", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-live-agent-supervised-revive-${process.pid}-${Date.now()}`);
  const fakeCodexScript = writeFakeLiveCodex();

  const output = execFileSync(
    process.execPath,
    [
      liveDemo,
      "--workspace",
      workspace,
      "--driver",
      "codex",
      "--reset",
      "--fault",
      "supervised-revive",
      "--max-turns",
      "8",
      "--max-runtime-seconds",
      "160",
      "--execute-limit",
      "3",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        SWARM_CODEX_COMMAND: process.execPath,
        SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
        SWARM_AGENT_IDLE_TIMEOUT_SECONDS: "1",
        TEST_SWARM_CLI: cli,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const summary = JSON.parse(output);

  assert.equal(summary.workspace, workspace);
  assert.equal(summary.phase, "phase-6-fault-injection");
  assert.equal(summary.fault.mode, "supervised-revive");
  assert.equal(summary.finalOutcome, "accepted");
  assert.equal(summary.finalSliceStatus, "accepted");
  assert.equal(summary.outcomeClassification.code, "accepted");
  assert.ok(Object.entries(summary.assertions).every(([, value]) => value === true));
  assert.ok(summary.turns.some((turn) => turn.kind === "supervised-recovery"));
  assert.equal(summary.supervisedRecovery.sliceId, summary.sliceId);
  assert.match(summary.supervisedRecovery.recoveredRunId, /^RUN-/);
  assert.match(summary.supervisedRecovery.revivedRunId, /^RUN-/);
  assert.equal(summary.supervisedRecovery.revivedRunStatus, "completed");
  assert.equal(summary.supervisedRecovery.restartedAtTurn, undefined);
  assert.ok(summary.supervisedRecovery.detectedAtTurn >= 1);
  assert.ok(summary.supervisedRecovery.revivedAtTurn >= summary.supervisedRecovery.detectedAtTurn);
  assert.ok(summary.verifyRuns.some((run) => run.turn > summary.supervisedRecovery.detectedAtTurn && run.accepted));
  assert.ok(fs.existsSync(summary.artifacts.recoveryRevive));
  assertArtifactIndex(summary, "accepted", ["recoveryRevive", "workerResult", "reviewerResult", "verificationOutput"]);

  const reviveTranscript = fs.readFileSync(summary.artifacts.recoveryRevive, "utf8");
  assert.match(reviveTranscript, /Revived for RUN-/);
  assert.match(reviveTranscript, /session:/);

  const snapshot = JSON.parse(fs.readFileSync(summary.artifacts.snapshot, "utf8"));
  const slice = snapshot.slices.find((item) => item.id === summary.sliceId);
  const recoveredRun = snapshot.agentRuns.find((item) => item.id === summary.supervisedRecovery.recoveredRunId);
  const revivedRun = snapshot.agentRuns.find((item) => item.id === summary.supervisedRecovery.revivedRunId);
  assert.equal(slice.status, "accepted");
  assert.equal(recoveredRun.status, "failed");
  assert.ok(recoveredRun.sessionId);
  assert.equal(revivedRun.status, "completed");
  assert.equal(revivedRun.sessionId, recoveredRun.sessionId);
  assert.ok(snapshot.recentEvents.some((event) => event.type === "worker.child_idle_timeout"));
  assert.ok(snapshot.recentEvents.some((event) => event.type === "worker.completed" && event.payload?.idleTimedOut === true));
  assert.ok(snapshot.recentEvents.some((event) => event.type === "recovery.revive_started"));
  assert.ok(snapshot.recentEvents.some((event) => event.type === "recovery.revive_completed" && event.payload?.ok === true));
  assert.ok(!snapshot.recentEvents.some((event) => event.type === "recovery.restart_completed"));
  assert.ok(snapshot.recentEvents.some((event) => event.type === "verification.completed" && event.payload.passed === true));

  const manifest = JSON.parse(fs.readFileSync(path.join(workspace, "live-agent-smoke.json"), "utf8"));
  assert.equal(manifest.phase, "phase-6-fault-injection");
  assert.equal(manifest.liveRun.fault, "supervised-revive");
  assert.equal(manifest.liveRun.finalOutcome, "accepted");
});

test("live agent runner resumes from generated context handoff packets", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-live-agent-context-handoff-${process.pid}-${Date.now()}`);
  const fakeCodexScript = writeFakeLiveCodex();

  const output = execFileSync(
    process.execPath,
    [
      liveDemo,
      "--workspace",
      workspace,
      "--driver",
      "codex",
      "--reset",
      "--fault",
      "context-handoff",
      "--max-turns",
      "8",
      "--max-runtime-seconds",
      "120",
      "--execute-limit",
      "3",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        SWARM_CODEX_COMMAND: process.execPath,
        SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
        TEST_SWARM_CLI: cli,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const summary = JSON.parse(output);

  assert.equal(summary.workspace, workspace);
  assert.equal(summary.phase, "phase-6-fault-injection");
  assert.equal(summary.fault.mode, "context-handoff");
  assert.equal(summary.finalOutcome, "accepted");
  assert.equal(summary.finalSliceStatus, "accepted");
  assert.equal(summary.outcomeClassification.code, "accepted");
  assert.ok(Object.entries(summary.assertions).every(([, value]) => value === true));
  assert.ok(summary.turns.some((turn) => turn.kind === "context-handoff"));
  assert.equal(summary.contextHandoff.sliceId, summary.sliceId);
  assert.match(summary.contextHandoff.workerRunId, /^RUN-/);
  assert.ok(summary.contextHandoff.generatedAtTurn >= 1);
  assert.ok(summary.verifyRuns.some((run) => run.turn > summary.contextHandoff.generatedAtTurn && run.accepted));

  for (const artifact of [
    summary.artifacts.contextWorkerPacket,
    summary.artifacts.contextReviewerPacket,
    summary.artifacts.contextVerifierPacket,
    summary.artifacts.contextOverseerPacket,
    summary.artifacts.contextRecoveryPacket,
  ]) {
    assert.ok(fs.existsSync(artifact), `Missing artifact: ${artifact}`);
  }
  assertArtifactIndex(summary, "accepted", [
    "contextWorkerPacket",
    "contextReviewerPacket",
    "contextVerifierPacket",
    "contextOverseerPacket",
    "contextRecoveryPacket",
  ]);

  const workerPacket = fs.readFileSync(summary.artifacts.contextWorkerPacket, "utf8");
  assert.match(workerPacket, /Resume Packet: worker slice:/);
  assert.match(workerPacket, /Worker Focus/);
  assert.match(workerPacket, /FR\/AC Scope/);
  assert.match(workerPacket, /Guardrails/);

  const reviewerPacket = fs.readFileSync(summary.artifacts.contextReviewerPacket, "utf8");
  assert.match(reviewerPacket, /Reviewer \/ Sleuth Focus/);
  assert.match(reviewerPacket, /Worker claims/);

  const verifierPacket = fs.readFileSync(summary.artifacts.contextVerifierPacket, "utf8");
  assert.match(verifierPacket, /Verifier Focus/);
  assert.match(verifierPacket, /Block acceptance unless every in-scope FR\/AC/);

  const overseerPacket = fs.readFileSync(summary.artifacts.contextOverseerPacket, "utf8");
  assert.match(overseerPacket, /Resume Packet: overseer lane:/);
  assert.match(overseerPacket, /Planner \/ Overseer Focus/);

  const recoveryPacket = fs.readFileSync(summary.artifacts.contextRecoveryPacket, "utf8");
  assert.match(recoveryPacket, /Resume Packet: recovery agent_run:/);
  assert.match(recoveryPacket, /Recovery Focus/);

  const snapshot = JSON.parse(fs.readFileSync(summary.artifacts.snapshot, "utf8"));
  const slice = snapshot.slices.find((item) => item.id === summary.sliceId);
  assert.equal(slice.status, "accepted");
  assert.ok(
    ["worker", "reviewer", "verifier"].every((role) =>
      snapshot.checkpoints.some(
        (checkpoint) =>
          checkpoint.role === role &&
          checkpoint.entityType === "slice" &&
          checkpoint.entityId === summary.sliceId,
      ),
    ),
  );
  assert.ok(
    snapshot.checkpoints.some(
      (checkpoint) =>
        checkpoint.role === "overseer" &&
        checkpoint.entityType === "lane" &&
        checkpoint.entityId === summary.contextHandoff.laneId,
    ),
  );
  assert.ok(
    snapshot.recentEvents.some(
      (event) => event.type === "checkpoint.refreshed" && event.actor === "live-context-handoff",
    ),
  );
  assert.ok(snapshot.recentEvents.some((event) => event.type === "review.completed"));
  assert.ok(snapshot.recentEvents.some((event) => event.type === "verification.completed" && event.payload.passed === true));

  const manifest = JSON.parse(fs.readFileSync(path.join(workspace, "live-agent-smoke.json"), "utf8"));
  assert.equal(manifest.phase, "phase-6-fault-injection");
  assert.equal(manifest.liveRun.fault, "context-handoff");
  assert.equal(manifest.liveRun.finalOutcome, "accepted");
});

test("live agent runner surfaces low-signal proof churn without bypassing gates", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-live-agent-low-signal-${process.pid}-${Date.now()}`);
  const fakeCodexScript = writeFakeLiveCodex();

  const output = execFileSync(
    process.execPath,
    [
      liveDemo,
      "--workspace",
      workspace,
      "--driver",
      "codex",
      "--reset",
      "--fault",
      "low-signal",
      "--max-turns",
      "8",
      "--max-runtime-seconds",
      "120",
      "--execute-limit",
      "3",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        SWARM_CODEX_COMMAND: process.execPath,
        SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
        TEST_SWARM_CLI: cli,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const summary = JSON.parse(output);

  assert.equal(summary.workspace, workspace);
  assert.equal(summary.phase, "phase-6-fault-injection");
  assert.equal(summary.fault.mode, "low-signal");
  assert.equal(summary.finalOutcome, "accepted");
  assert.equal(summary.finalSliceStatus, "accepted");
  assert.equal(summary.outcomeClassification.code, "accepted");
  assert.ok(Object.entries(summary.assertions).every(([, value]) => value === true));
  assert.ok(summary.turns.some((turn) => turn.kind === "low-signal-warning"));
  assert.equal(summary.lowSignal.sliceId, summary.sliceId);
  assert.match(summary.lowSignal.escalationId, /^ESC-/);
  assert.match(summary.lowSignal.checkpointId, /^CHK-/);
  assert.ok(summary.lowSignal.injectedAtTurn >= 1);
  assert.ok(summary.verifyRuns.some((run) => run.turn > summary.lowSignal.injectedAtTurn && run.accepted));
  assert.ok(fs.existsSync(summary.artifacts.lowSignalWarning));
  assertArtifactIndex(summary, "accepted", ["lowSignalWarning", "workerResult", "reviewerResult", "verificationOutput"]);

  const warning = JSON.parse(fs.readFileSync(summary.artifacts.lowSignalWarning, "utf8"));
  assert.equal(warning.mode, "low-signal");
  assert.equal(warning.sliceId, summary.sliceId);
  assert.match(warning.message, /Low-signal slice cadence detected/);
  assert.match(warning.expectedContinuation, /Independent review and deterministic verification/);

  const snapshot = JSON.parse(fs.readFileSync(summary.artifacts.snapshot, "utf8"));
  const slice = snapshot.slices.find((item) => item.id === summary.sliceId);
  assert.equal(slice.status, "accepted");
  assert.ok(
    snapshot.activeEscalations.some(
      (item) =>
        item.id === summary.lowSignal.escalationId &&
        item.level === "warning" &&
        item.entityType === "lane" &&
        item.entityId === summary.lowSignal.laneId &&
        item.message.includes("Low-signal slice cadence detected"),
    ),
  );
  assert.ok(
    snapshot.recentEvents.some(
      (event) =>
        event.type === "planner.low_signal_work" &&
        event.entityType === "lane" &&
        event.entityId === summary.lowSignal.laneId &&
        event.payload.faultMode === "low-signal",
    ),
  );
  assert.ok(
    snapshot.checkpoints.some(
      (checkpoint) =>
        checkpoint.id === summary.lowSignal.checkpointId &&
        checkpoint.role === "planner" &&
        checkpoint.entityType === "lane" &&
        checkpoint.entityId === summary.lowSignal.laneId,
    ),
  );
  assert.ok(snapshot.recentEvents.some((event) => event.type === "review.completed"));
  assert.ok(snapshot.recentEvents.some((event) => event.type === "verification.completed" && event.payload.passed === true));

  const manifest = JSON.parse(fs.readFileSync(path.join(workspace, "live-agent-smoke.json"), "utf8"));
  assert.equal(manifest.phase, "phase-6-fault-injection");
  assert.equal(manifest.liveRun.fault, "low-signal");
  assert.equal(manifest.liveRun.finalOutcome, "accepted");
});

test("live agent run history archives summaries and compares reset runs", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const historyRoot = path.join(repoRoot, ".swarm-demo", `test-live-agent-history-${suffix}`);
  const acceptedWorkspace = path.join(repoRoot, ".swarm-demo", `test-live-agent-history-accepted-${suffix}`);
  const mutationWorkspace = path.join(repoRoot, ".swarm-demo", `test-live-agent-history-mutation-${suffix}`);
  const fakeCodexScript = writeFakeLiveCodex();
  fs.rmSync(historyRoot, { recursive: true, force: true });

  const acceptedOutput = execFileSync(
    process.execPath,
    [
      liveDemo,
      "--workspace",
      acceptedWorkspace,
      "--driver",
      "codex",
      "--reset",
      "--run-id",
      `RUN-history-accepted-${suffix}`,
      "--history-root",
      historyRoot,
      "--max-turns",
      "6",
      "--max-runtime-seconds",
      "120",
      "--execute-limit",
      "3",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        SWARM_CODEX_COMMAND: process.execPath,
        SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
        TEST_SWARM_CLI: cli,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const acceptedSummary = JSON.parse(acceptedOutput);

  const mutationOutput = execFileSync(
    process.execPath,
    [
      liveDemo,
      "--workspace",
      mutationWorkspace,
      "--driver",
      "codex",
      "--reset",
      "--fault",
      "source-mutation",
      "--run-id",
      `RUN-history-source-mutation-${suffix}`,
      "--history-root",
      historyRoot,
      "--max-turns",
      "3",
      "--max-runtime-seconds",
      "120",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        SWARM_CODEX_COMMAND: process.execPath,
        SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
        TEST_SWARM_CLI: cli,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const mutationSummary = JSON.parse(mutationOutput);

  assertRunHistory(acceptedSummary, historyRoot);
  assertRunHistory(mutationSummary, historyRoot);

  const historyIndex = JSON.parse(fs.readFileSync(path.join(historyRoot, "runs.json"), "utf8"));
  assert.equal(historyIndex.runs.length, 2);
  assert.deepEqual(
    historyIndex.runs.map((run) => run.runId),
    [acceptedSummary.runId, mutationSummary.runId],
  );

  const explicitOutput = execFileSync(
    process.execPath,
    [
      compareLiveRuns,
      "--history-root",
      historyRoot,
      "--left",
      acceptedSummary.runId,
      "--right",
      mutationSummary.runId,
      "--format",
      "json",
    ],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const comparison = JSON.parse(explicitOutput);
  assert.equal(comparison.left.runId, acceptedSummary.runId);
  assert.equal(comparison.right.runId, mutationSummary.runId);
  assert.equal(comparison.left.finalOutcome, "accepted");
  assert.equal(comparison.right.finalOutcome, "human_required");
  assert.equal(comparison.left.classification.code, "accepted");
  assert.equal(comparison.right.classification.code, "source_mutation");
  assert.equal(comparison.changes.finalOutcomeChanged, true);
  assert.equal(comparison.changes.classificationChanged, true);
  assert.equal(comparison.changes.faultModeChanged, true);
  assert.ok(comparison.deltas.counts.agentRuns < 0);
  assert.ok(comparison.deltas.counts.verifyRuns < 0);
  assert.ok(Object.entries(comparison.assertions).every(([, value]) => value === true));
  assert.ok(fs.existsSync(comparison.artifacts.leftSummary));
  assert.ok(fs.existsSync(comparison.artifacts.rightSummary));
  assert.ok(fs.existsSync(comparison.artifacts.leftArtifactIndex));
  assert.ok(fs.existsSync(comparison.artifacts.rightArtifactIndex));

  const latestOutput = execFileSync(
    process.execPath,
    [compareLiveRuns, "--history-root", historyRoot, "--format", "json"],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const latestComparison = JSON.parse(latestOutput);
  assert.equal(latestComparison.left.runId, acceptedSummary.runId);
  assert.equal(latestComparison.right.runId, mutationSummary.runId);
});

test("full-product mode coordinates backend and dashboard through product readiness acceptance", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-live-agent-full-product-${process.pid}-${Date.now()}`);
  const historyRoot = path.join(repoRoot, ".swarm-demo", `test-live-agent-full-product-history-${process.pid}-${Date.now()}`);
  const fakeCodexScript = writeFakeLiveCodex();

  const output = execFileSync(
    process.execPath,
    [
      liveDemo,
      "--workspace",
      workspace,
      "--driver",
      "codex",
      "--reset",
      "--mode",
      "full-product",
      "--max-turns",
      "10",
      "--max-runtime-seconds",
      "120",
      "--execute-limit",
      "3",
      "--history-root",
      historyRoot,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        SWARM_CODEX_COMMAND: process.execPath,
        SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
        TEST_SWARM_CLI: cli,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const summary = JSON.parse(output);

  assert.equal(summary.mode, "full-product");
  assert.equal(summary.phase, "phase-8-full-product-execution");
  assert.equal(summary.finalOutcome, "accepted");
  assert.equal(summary.outcomeClassification.code, "accepted");
  assert.equal(summary.productReadiness.passed, true);
  assert.equal(summary.productReadiness.productSpec.exists, true);
  assert.equal(summary.productReadiness.productSpec.registered, true);
  assert.equal(summary.productReadiness.productSpec.unchanged, true);
  assert.equal(summary.productReadiness.blockers.length, 0);
  assert.equal(summary.productReadiness.dashboardDependencies.satisfied, true);
  assert.deepEqual(summary.productReadiness.dashboardDependencies.missingRefs, []);
  assert.equal(summary.productReadiness.commandResults.test.passed, true);
  assert.equal(summary.productReadiness.commandResults.start.passed, true);
  assert.equal(summary.productReadiness.commandResults.start.probes.ui.passed, true);
  assert.equal(summary.productReadiness.commandResults.start.probes.api.passed, true);
  assert.equal(summary.productReadiness.commandResults.start.probes.api.jsonFieldsPresent.openTotalCents, true);
  assert.equal(summary.productReadiness.commandResults.start.probes.markPaid.passed, true);
  assert.equal(summary.productReadiness.commandResults.start.probes.markPaid.paidCountIncreased, true);
  assert.equal(summary.productReadiness.commandResults.start.probes.markPaid.overdueCountDecreased, true);
  assert.equal(summary.productReadiness.dashboardSlices.accepted, 1);
  assert.ok(summary.turns.some((turn) => turn.kind === "product-readiness" && turn.passed === false));
  assert.ok(summary.dependencyWarningClearances.length >= 1);
  assert.equal(summary.counts.activeEscalations, 0);
  assert.match(summary.productReadiness.commands.manualUrl, /^http:\/\/127\.0\.0\.1:/);
  assert.equal(summary.assertions.fullProductModeRequiresProductSpec, true);
  assert.equal(summary.assertions.fullProductReadinessRecorded, true);
  assert.equal(summary.assertions.productReadinessBlocksIncompleteTarget, true);
  assert.equal(summary.assertions.finalTargetSnapshotsArchived, true);
  assert.ok(Object.entries(summary.assertions).every(([, value]) => value === true));

  const dashboardTarget = path.join(workspace, "invoice-dashboard");
  const terminalDashboardPackage = JSON.parse(fs.readFileSync(path.join(dashboardTarget, "package.json"), "utf8"));
  assert.equal(terminalDashboardPackage.scripts.start, "node src/server.js");
  assert.ok(fs.existsSync(path.join(dashboardTarget, "src", "server.js")));
  assert.ok(fs.existsSync(path.join(dashboardTarget, "test", "dashboard.test.js")));

  for (const artifact of [
    summary.artifacts.productReadiness,
    summary.artifacts.productReadinessMarkdown,
    summary.artifacts.productTestOutput,
    summary.artifacts.productStartOutput,
    summary.artifacts.productProbe,
    summary.artifacts.productProbeMarkdown,
    summary.artifacts.finalInvoiceApi,
    summary.artifacts.finalInvoiceDashboard,
  ]) {
    assert.ok(fs.existsSync(artifact), `Missing product readiness artifact: ${artifact}`);
  }
  const archivedDashboardPackage = JSON.parse(
    fs.readFileSync(path.join(summary.history.finalTargets.invoiceDashboard.path, "package.json"), "utf8"),
  );
  assert.equal(archivedDashboardPackage.scripts.start, "node src/server.js");
  assert.ok(fs.existsSync(path.join(summary.history.finalTargets.invoiceDashboard.path, "src", "server.js")));
  const probeArtifact = JSON.parse(fs.readFileSync(summary.artifacts.productProbe, "utf8"));
  assert.equal(probeArtifact.passed, true);
  assert.equal(probeArtifact.probes.api.jsonFieldsPresent.openTotalCents, true);
  assert.equal(probeArtifact.probes.markPaid.passed, true);
  assert.equal(probeArtifact.probes.markPaid.patched.status, "paid");
  assertArtifactIndex(summary, "accepted", [
    "productReadiness",
    "productReadinessMarkdown",
    "productTestOutput",
    "productStartOutput",
    "productProbe",
    "productProbeMarkdown",
    "finalInvoiceApi",
    "finalInvoiceDashboard",
  ]);

  const manifest = JSON.parse(fs.readFileSync(path.join(workspace, "live-agent-smoke.json"), "utf8"));
  assert.equal(manifest.phase, "phase-8-full-product-execution");
  assert.equal(manifest.liveRun.mode, "full-product");
  assert.equal(manifest.liveRun.finalOutcome, "accepted");
  assert.equal(manifest.liveRun.outcomeClassification.code, "accepted");
  assert.equal(manifest.liveRun.productReadiness.passed, true);
});

test("full-product mode turns runtime readiness blockers into visible follow-up work", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-live-agent-full-product-readiness-feedback-${process.pid}-${Date.now()}`);
  const fakeCodexScript = writeFakeLiveCodex();

  const output = execFileSync(
    process.execPath,
    [
      liveDemo,
      "--workspace",
      workspace,
      "--driver",
      "codex",
      "--reset",
      "--mode",
      "full-product",
      "--max-turns",
      "14",
      "--max-runtime-seconds",
      "120",
      "--execute-limit",
      "3",
      "--history",
      "false",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        SWARM_CODEX_COMMAND: process.execPath,
        SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
        SWARM_FAKE_DELAY_DASHBOARD_START: "true",
        TEST_SWARM_CLI: cli,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const summary = JSON.parse(output);

  assert.equal(summary.mode, "full-product");
  assert.equal(summary.finalOutcome, "accepted");
  assert.equal(summary.productReadiness.passed, true);
  assert.ok(summary.turns.some((turn) => turn.kind === "product-readiness-slice-created"));
  assert.ok(summary.turns.some((turn) => turn.kind === "product-readiness-deferred"));
  assert.equal(summary.productReadiness.productReadinessSlices.total, 1);
  assert.equal(summary.productReadiness.productReadinessSlices.active, 0);
  assert.ok(summary.productReadiness.productReadinessSlices.ids[0].refs.includes("AC-PROD-001.1"));
  assert.ok(summary.dependencyWarningClearances.length >= 1);
  assert.equal(summary.counts.activeEscalations, 0);
  assert.ok(Object.entries(summary.assertions).every(([, value]) => value === true));

  const snapshot = JSON.parse(fs.readFileSync(summary.artifacts.snapshot, "utf8"));
  const readinessSlice = snapshot.slices.find((slice) => slice.frAcRefs.includes("AC-PROD-001.1"));
  assert.equal(readinessSlice.status, "accepted");
  assert.ok(readinessSlice.scope.some((item) => item.includes("safe runtime proof")));
  assert.ok(readinessSlice.expectedEvidence.some((item) => item.includes("in-process HTTP probe")));
  assert.ok(readinessSlice.verificationRequirements.some((item) => item.includes("bounded HTTP probe")));
  assert.ok(snapshot.recentEvents.some((event) => event.type === "product_readiness.slice_created"));
  assert.equal(
    snapshot.activeEscalations.filter((item) =>
      /Invoice Dashboard source .*blocked.*backend|Historical dashboard prerequisite warnings|dashboard prerequisite warnings appear stale/i.test(
        item.message,
      ),
    ).length,
    0,
  );
  assert.ok(readinessSlice.evidence.some((item) => item.kind === "worker_result"));
  assert.ok(readinessSlice.evidence.some((item) => item.kind === "review_result"));
  assert.ok(readinessSlice.evidence.some((item) => item.kind === "command" && item.payload.passed === true));
});

test("full-product mode preserves product_not_ready classification when bounds stop before product completion", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-live-agent-full-product-bounded-${process.pid}-${Date.now()}`);
  const fakeCodexScript = writeFakeLiveCodex();

  const output = execFileSync(
    process.execPath,
    [
      liveDemo,
      "--workspace",
      workspace,
      "--driver",
      "codex",
      "--reset",
      "--mode",
      "full-product",
      "--max-turns",
      "1",
      "--max-runtime-seconds",
      "120",
      "--execute-limit",
      "3",
      "--history",
      "false",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        SWARM_CODEX_COMMAND: process.execPath,
        SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
        TEST_SWARM_CLI: cli,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const summary = JSON.parse(output);

  assert.equal(summary.mode, "full-product");
  assert.equal(summary.finalOutcome, "blocked");
  assert.equal(summary.outcomeClassification.code, "product_not_ready");
  assert.equal(summary.productReadiness.passed, false);
  assert.ok(summary.productReadiness.blockers.some((item) => item.id === "dashboard-dependencies-accepted"));
  assert.ok(summary.productReadiness.blockers.some((item) => item.id === "dashboard-slice-accepted"));
  assert.ok(summary.productReadiness.blockers.some((item) => item.id === "dashboard-start-script"));
  assert.ok(summary.productReadiness.dashboardDependencies.missingRefs.includes("AC-INV-002.2"));
  assert.ok(fs.existsSync(summary.artifacts.productReadiness));
  assertArtifactIndex(summary, "product_not_ready", ["productReadiness", "productReadinessMarkdown", "productTestOutput"]);
});

test("full-product mode refuses to run without the approved product spec copy", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-live-agent-full-product-missing-spec-${process.pid}-${Date.now()}`);

  execFileSync(
    process.execPath,
    [
      liveDemo,
      "--workspace",
      workspace,
      "--driver",
      "fixture",
      "--reset",
      "--max-turns",
      "0",
      "--history",
      "false",
    ],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  fs.rmSync(path.join(workspace, "source-specs", "live-smoke-invoice-dashboard-product-spec.md"), { force: true });

  let error;
  try {
    execFileSync(
      process.execPath,
      [
        liveDemo,
        "--workspace",
        workspace,
        "--driver",
        "fixture",
        "--mode",
        "full-product",
        "--max-turns",
        "0",
        "--history",
        "false",
      ],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, "Expected full-product mode to fail when the product spec copy is missing");
  assert.match(String(error.stderr), /Full-product mode requires copied product spec/);
});

function assertArtifactIndex(summary, expectedClassification, requiredKeys) {
  assert.ok(fs.existsSync(summary.artifacts.artifactIndex), `Missing artifact index: ${summary.artifacts.artifactIndex}`);
  assert.ok(
    fs.existsSync(summary.artifacts.artifactIndexMarkdown),
    `Missing artifact index markdown: ${summary.artifacts.artifactIndexMarkdown}`,
  );
  assert.equal(summary.artifactIndex.path, summary.artifacts.artifactIndex);
  assert.equal(summary.artifactIndex.markdownPath, summary.artifacts.artifactIndexMarkdown);
  assert.equal(summary.artifactIndex.missingExpected.length, 0);

  const index = JSON.parse(fs.readFileSync(summary.artifacts.artifactIndex, "utf8"));
  assert.equal(index.classification.code, expectedClassification);
  assert.equal(index.finalOutcome, summary.finalOutcome);
  assert.equal(index.counts.missingExpected, 0);
  for (const key of requiredKeys) {
    assert.ok(index.items.some((item) => item.key === key && item.exists), `Missing indexed artifact: ${key}`);
  }

  const markdown = fs.readFileSync(summary.artifacts.artifactIndexMarkdown, "utf8");
  assert.match(markdown, /# Live Agent Smoke Artifact Index/);
  assert.match(markdown, new RegExp(`Classification: ${expectedClassification}`));
  return index;
}

function assertRunHistory(summary, expectedHistoryRoot) {
  assert.equal(summary.history.enabled, true);
  assert.equal(summary.history.root, expectedHistoryRoot);
  assert.ok(summary.runId.startsWith("RUN-history-"));
  assert.equal(summary.assertions.runHistoryArchived, true);
  assert.ok(fs.existsSync(summary.history.summary), `Missing archived summary: ${summary.history.summary}`);
  assert.ok(fs.existsSync(summary.history.artifactIndex), `Missing archived artifact index: ${summary.history.artifactIndex}`);
  assert.ok(
    fs.existsSync(summary.history.artifactIndexMarkdown),
    `Missing archived artifact index markdown: ${summary.history.artifactIndexMarkdown}`,
  );
  const archivedSummary = JSON.parse(fs.readFileSync(summary.history.summary, "utf8"));
  assert.equal(archivedSummary.runId, summary.runId);
  assert.equal(archivedSummary.outcomeClassification.code, summary.outcomeClassification.code);
}

function writeFakeLiveCodex() {
  const fakeCodexDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-swarm-fake-live-runner-"));
  const scriptPath = path.join(fakeCodexDir, "fake-live-codex.mjs");
  const workerCountPath = path.join(fakeCodexDir, "worker-count.txt");
  const reviewCountPath = path.join(fakeCodexDir, "review-count.txt");
  fs.writeFileSync(
    scriptPath,
    `import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
const schemaIndex = args.indexOf("--output-schema");
const schemaPath = schemaIndex >= 0 ? args[schemaIndex + 1] : "";
const cli = process.env.TEST_SWARM_CLI;
const fault = process.env.SWARM_LIVE_FAULT || "none";
const delayDashboardStart = process.env.SWARM_FAKE_DELAY_DASHBOARD_START === "true";
const isResumeInvocation = args.includes("resume");
const workerCountPath = ${JSON.stringify(workerCountPath)};
const reviewCountPath = ${JSON.stringify(reviewCountPath)};
const rawPrompt = args.at(-1) ?? "";
const promptPath = parsePromptPath(rawPrompt);
const prompt = rawPrompt.includes("Current harness snapshot:")
  ? rawPrompt
  : promptPath && fs.existsSync(promptPath)
    ? fs.readFileSync(promptPath, "utf8")
    : rawPrompt;
const snapshot = parseSnapshot(prompt);
const sliceId = extractSliceId(prompt);
const isFullProductPrompt =
  prompt.includes('"mode": "full-product"') ||
  prompt.includes('"phase": "phase-8-full-product-foundation"') ||
  prompt.includes('"phase": "phase-8-full-product-execution"') ||
  isFullProductWorkspace();
let refs = readSliceRefs(sliceId) ?? extractRefs(prompt);
const isDashboardTarget = path.basename(process.cwd()).toLowerCase().includes("dashboard");
if (isDashboardTarget && !refs.some((ref) => ref.startsWith("AC-UI") || ref.startsWith("AC-PROD"))) {
  refs = [
    "AC-UI-INV-001.1",
    "AC-UI-INV-001.2",
    "AC-UI-INV-001.3"
  ];
} else if (isFullProductPrompt && refs.some((ref) => ref.startsWith("AC-INV"))) {
  refs = [
    "AC-INV-001.1",
    "AC-INV-001.2",
    "AC-INV-001.3",
    "AC-INV-002.1",
    "AC-INV-002.2",
    "AC-INV-003.1",
    "AC-INV-003.2"
  ];
}
const isProductRuntimeSlice = refs.some((ref) => ref.startsWith("AC-PROD"));
const isDashboardSlice = isDashboardTarget || refs.some((ref) => ref.startsWith("AC-UI") || ref.startsWith("AC-PROD"));

console.log(JSON.stringify({
  type: "thread.started",
  thread_id: schemaPath.includes("overseer-decision")
    ? "fake-live-overseer-thread"
    : schemaPath.includes("review-result")
      ? "fake-live-review-thread"
      : "fake-live-worker-thread"
}));

if (schemaPath.includes("overseer-decision")) {
  console.log(JSON.stringify({ type: "overseer.analysis", status: "recommend_commands" }));
  const plan = chooseOverseerCommand(snapshot, isFullProductPrompt);
  const command = plan.command;
  const focus = plan.focus || "backend";
  if (outputPath) {
    fs.writeFileSync(outputPath, JSON.stringify({
      status: "recommend_commands",
      summary: plan.summary,
      scenario: "live-agent-smoke",
      currentPriority: plan.currentPriority,
      recommendedCommands: [command, {
        command: \`node "\${cli}" observe --events 160\`,
        purpose: "Refresh visible state after this overseer action.",
        expectedStateChange: "Snapshot shows the latest lane, slice, agents, and evidence.",
        requiresHuman: false
      }],
      lanePlan: [{
        laneName: focus === "dashboard" ? "Dashboard Lane: Invoice Operations Product" : "Backend Lane: Invoice Query Core",
        purpose: focus === "dashboard"
          ? "Complete the runnable invoice dashboard product after backend acceptance."
          : "Complete backend invoice behavior before dashboard work.",
        nextAction: command.purpose
      }],
      blockers: plan.blockers ?? [],
      stopCondition: "Stop after bounded command execution; the live runner will decide the next turn.",
      nextAction: "Observe the result and continue the acceptance loop."
    }) + "\\n", "utf8");
  }
} else if (schemaPath.includes("review-result")) {
  const reviewAttempt = incrementCounter(reviewCountPath);
  const repairRequired = fault === "reviewer-repair" && reviewAttempt === 1;
  console.log(JSON.stringify({ type: "review.analysis", status: repairRequired ? "repair_required" : "accepted" }));
  if (outputPath) {
    if (repairRequired) {
      fs.writeFileSync(outputPath, JSON.stringify({
        status: "repair_required",
        summary: "fake reviewer requires repair before acceptance",
        frAcFindings: refs.map((ref) => ({
          ref,
          status: ref === "AC-INV-001.2" ? "failed" : "passed",
          evidence: ["fake-review-evidence"],
          finding: ref === "AC-INV-001.2"
            ? "Customer filter behavior is missing from the worker implementation."
            : "Worker evidence is sufficient for this ref."
        })),
        testAssessment: "Tests are incomplete because customer filtering is not proven.",
        sourceMutationDetected: false,
        stubOrHardcodeRisk: "medium",
        requiredFixes: ["Add customerId filtering behavior and tests."],
        escalations: [{ level: "blocker", message: "reviewer requested repair for missing customer filter" }],
        recommendation: "Repair customer filtering before deterministic verification."
      }) + "\\n", "utf8");
    } else {
      fs.writeFileSync(outputPath, JSON.stringify({
        status: "accepted",
        summary: isDashboardSlice
          ? "fake reviewer accepted live-runner dashboard product slice"
          : "fake reviewer accepted live-runner backend slice",
        frAcFindings: refs.map((ref) => ({
          ref,
          status: "passed",
          evidence: ["fake-review-evidence"],
          finding: "Worker evidence and runtime changes cover this ref."
        })),
        testAssessment: isDashboardSlice
          ? "Worker evidence includes dashboard model tests and local server start behavior."
          : "Worker evidence includes behavior-focused invoice query tests.",
        sourceMutationDetected: false,
        stubOrHardcodeRisk: "none",
        requiredFixes: [],
        escalations: [],
        recommendation: "Proceed to deterministic verification."
      }) + "\\n", "utf8");
    }
  }
} else {
  const workerAttempt = incrementCounter(workerCountPath);
  const incompleteRepairAttempt = fault === "reviewer-repair" && workerAttempt === 1;
  const shouldStallForSupervisedRevive = fault === "supervised-revive" && !isResumeInvocation && workerAttempt === 1;
  if (shouldStallForSupervisedRevive) {
    console.log(JSON.stringify({
      type: "item.started",
      item: {
        type: "command_execution",
        command: "npm test",
        status: "running"
      }
    }));
    await sleep(60000);
    process.exit(0);
  }
  if (isDashboardSlice) {
    const omitStart = delayDashboardStart && !isProductRuntimeSlice;
    console.log(JSON.stringify({ type: "item.started", item: { type: "file_change", path: "src/server.js" } }));
    writeDashboardImplementation({ omitStart });
    if (outputPath) {
      fs.writeFileSync(outputPath, JSON.stringify({
        status: "passed",
        summary: omitStart
          ? "fake worker implemented dashboard model behavior but left runtime start for product readiness"
          : "fake worker implemented a runnable invoice operations dashboard",
        changedFiles: omitStart
          ? ["package.json", "src/dashboard.js", "test/dashboard.test.js"]
          : ["package.json", "src/dashboard.js", "src/server.js", "test/dashboard.test.js"],
        commandsRun: ["npm test"],
        testsRun: ["npm test"],
        frAcCoverage: refs.map((ref) => ({
          ref,
          status: "covered",
          evidence: omitStart
            ? "Dashboard model tests cover the UI slice; product runtime remains for final readiness."
            : "Dashboard model tests and local server behavior cover the dashboard slice."
        })),
        risks: omitStart ? ["npm start intentionally omitted for product-readiness feedback coverage."] : [],
        nextRecommendation: "Run independent review and deterministic verification."
      }) + "\\n", "utf8");
    }
  } else {
  console.log(JSON.stringify({ type: "item.started", item: { type: "file_change", path: "src/invoices.js" } }));
  fs.writeFileSync(path.join(process.cwd(), "src", "invoices.js"), incompleteRepairAttempt ? \`const invoices = [
  { id: "INV-1001", customerId: "CUST-1", status: "open", totalCents: 12500 },
  { id: "INV-1002", customerId: "CUST-1", status: "paid", totalCents: 9900 },
  { id: "INV-1003", customerId: "CUST-2", status: "open", totalCents: 4500 },
];

export function listInvoices(filters = {}) {
  return invoices.filter((invoice) => {
    if (filters.status && invoice.status !== filters.status) return false;
    return true;
  });
}

export function getInvoiceById(id) {
  return invoices.find((invoice) => invoice.id === id) ?? null;
}

export function getInvoiceSummary() {
  const openInvoices = invoices.filter((invoice) => invoice.status === "open");
  return {
    count: invoices.length,
    openCount: openInvoices.length,
    paidCount: invoices.filter((invoice) => invoice.status === "paid").length,
    totalOpenCents: openInvoices.reduce((total, invoice) => total + invoice.totalCents, 0),
  };
}
\` : \`const invoices = [
  { id: "INV-1001", customerId: "CUST-1", status: "open", totalCents: 12500 },
  { id: "INV-1002", customerId: "CUST-1", status: "paid", totalCents: 9900 },
  { id: "INV-1003", customerId: "CUST-2", status: "open", totalCents: 4500 },
];

export function listInvoices(filters = {}) {
  return invoices.filter((invoice) => {
    if (filters.status && invoice.status !== filters.status) return false;
    if (filters.customerId && invoice.customerId !== filters.customerId) return false;
    return true;
  });
}

export function getInvoiceById(id) {
  return invoices.find((invoice) => invoice.id === id) ?? null;
}

export function getInvoiceSummary() {
  const openInvoices = invoices.filter((invoice) => invoice.status === "open");
  return {
    count: invoices.length,
    openCount: openInvoices.length,
    paidCount: invoices.filter((invoice) => invoice.status === "paid").length,
    totalOpenCents: openInvoices.reduce((total, invoice) => total + invoice.totalCents, 0),
  };
}
\`, "utf8");
  fs.writeFileSync(path.join(process.cwd(), "test", "invoices.test.js"), \`import test from "node:test";
import assert from "node:assert/strict";
import { getInvoiceById, getInvoiceSummary, listInvoices } from "../src/invoices.js";

test("lists seeded invoices", () => {
  assert.equal(listInvoices().length, 3);
});

test("lists only open invoices when filtered by open status", () => {
  assert.deepEqual(
    listInvoices({ status: "open" }).map((invoice) => invoice.id),
    ["INV-1001", "INV-1003"],
  );
});

test("lists only invoices for the requested customer", () => {
  assert.deepEqual(
    listInvoices({ customerId: "CUST-1" }).map((invoice) => invoice.id),
    ["INV-1001", "INV-1002"],
  );
});

test("returns invoice dashboard summary values for seeded data", () => {
  assert.deepEqual(getInvoiceSummary(), {
    count: 3,
    openCount: 2,
    paidCount: 1,
    totalOpenCents: 17000,
  });
});

test("fetches a seeded invoice by id", () => {
  assert.deepEqual(getInvoiceById("INV-1001"), {
    id: "INV-1001",
    customerId: "CUST-1",
    status: "open",
    totalCents: 12500,
  });
});

test("returns null when fetching a missing invoice", () => {
  assert.equal(getInvoiceById("INV-9999"), null);
});
\`, "utf8");
  if (outputPath) {
    fs.writeFileSync(outputPath, JSON.stringify({
      status: "passed",
      summary: "fake worker implemented invoice query filtering",
      changedFiles: ["src/invoices.js", "test/invoices.test.js"],
      commandsRun: ["npm test"],
      testsRun: ["npm test"],
      frAcCoverage: refs.map((ref) => ({
        ref,
        status: "covered",
        evidence: "Invoice query behavior is covered by listInvoices tests."
      })),
      risks: [],
      nextRecommendation: "Run independent review and deterministic verification."
    }) + "\\n", "utf8");
  }
  }
}

console.log(JSON.stringify({ type: "turn.completed" }));

function parsePromptPath(value) {
  const match = /([A-Za-z]:\\\\[^\\r\\n]+overseer-prompt-[^\\r\\n]+\\.md)/.exec(value);
  if (match) return match[1];
  const separator = value.lastIndexOf(": ");
  return separator >= 0 ? value.slice(separator + 2).trim() : undefined;
}

function extractSliceId(prompt) {
  return /\\bSLICE-[a-f0-9]+\\b/i.exec(prompt)?.[0];
}

function readSliceRefs(sliceId) {
  if (!sliceId || !cli) return undefined;
  try {
    const output = execFileSync(process.execPath, [cli, "observe", "--events", "1"], {
      cwd: path.dirname(process.cwd()),
      encoding: "utf8",
      timeout: 5000
    });
    const snapshot = JSON.parse(output);
    const slice = Array.isArray(snapshot.slices)
      ? snapshot.slices.find((item) => item.id === sliceId)
      : undefined;
    return Array.isArray(slice?.frAcRefs) && slice.frAcRefs.length > 0 ? slice.frAcRefs : undefined;
  } catch {
    return undefined;
  }
}

function isFullProductWorkspace() {
  try {
    const manifestPath = path.join(path.dirname(process.cwd()), "live-agent-smoke.json");
    if (!fs.existsSync(manifestPath)) return false;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return (
      manifest?.mode === "full-product" ||
      manifest?.phase === "phase-8-full-product-foundation" ||
      manifest?.phase === "phase-8-full-product-execution"
    );
  } catch {
    return false;
  }
}

function parseSnapshot(prompt) {
  const normalized = prompt.replace(/\\r\\n/g, "\\n");
  const marker = "Current harness snapshot:\\n";
  const start = normalized.indexOf(marker);
  if (start < 0) return readHarnessSnapshot() ?? { slices: [] };
  const afterMarker = normalized.slice(start + marker.length);
  const end = afterMarker.indexOf("\\n\\nReturn only");
  const json = end >= 0 ? afterMarker.slice(0, end) : afterMarker;
  try {
    return JSON.parse(json);
  } catch {
    return readHarnessSnapshot() ?? { slices: extractSliceRecords(normalized) };
  }
}

function readHarnessSnapshot() {
  if (!cli) return undefined;
  for (const cwd of [process.cwd(), path.dirname(process.cwd())]) {
    if (!fs.existsSync(path.join(cwd, ".swarm", "state.db"))) continue;
    try {
      const output = execFileSync(process.execPath, [cli, "observe", "--events", "80"], {
        cwd,
        encoding: "utf8",
        timeout: 5000
      });
      return JSON.parse(output);
    } catch {
      continue;
    }
  }
  return undefined;
}

function extractSliceRecords(prompt) {
  const records = [];
  const matches = [...prompt.matchAll(/"id":\\s*"(SLICE-[^"]+)"/g)];
  for (const match of matches) {
    const window = prompt.slice(match.index, Math.min(prompt.length, match.index + 2500));
    const status = /"status":\\s*"([^"]+)"/.exec(window)?.[1];
    const refsBlock = /"frAcRefs":\\s*\\[([\\s\\S]*?)\\]/.exec(window)?.[1] ?? "";
    const frAcRefs = [...refsBlock.matchAll(/"([^"]+)"/g)].map((refMatch) => refMatch[1]);
    if (status && frAcRefs.length > 0) {
      records.push({ id: match[1], status, frAcRefs });
    }
  }
  return [...new Map(records.map((record) => [record.id, record])).values()];
}

function extractRefs(prompt) {
  const normalized = prompt.replace(/\\r\\n/g, "\\n");
  const scopeMatch = /FR\\/AC scope:\\n([\\s\\S]*?)\\n\\n/.exec(normalized);
  const scope = scopeMatch ? scopeMatch[1] : normalized;
  const found = [...new Set([...scope.matchAll(/\\b(?:FR|AC)-[A-Z0-9]+(?:-[A-Z0-9]+)*(?:\\.[0-9]+)?\\b/gi)].map((match) => match[0].toUpperCase()))];
  return found.length > 0 ? found : ["AC-INV-001.1", "AC-INV-001.2", "AC-INV-001.3"];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dashboardDependencyWarning() {
  return {
    level: "warning",
    message:
      "Invoice Dashboard source is blocked until backend refs AC-INV-001.1, AC-INV-001.2, AC-INV-002.1, AC-INV-002.2, and AC-INV-003.1 are accepted.",
    scope: "harness:scenario:live-agent-smoke"
  };
}

function dashboardDependencyWarningRealWording() {
  return {
    level: "warning",
    message:
      "Invoice Dashboard source is blocked by missing accepted backend prerequisite refs: AC-INV-001.1, AC-INV-001.2, AC-INV-002.1, AC-INV-002.2, AC-INV-003.1.",
    scope: "harness:scenario:live-agent-smoke"
  };
}

function dashboardHistoricalDependencyWarning() {
  return {
    level: "warning",
    message:
      "Historical dashboard prerequisite warnings appear stale because actionableState.nextSourcePullQueue reports dashboard dependencies accepted and blockedSourceQueue is empty.",
    scope: "harness:scenario:live-agent-smoke"
  };
}

function chooseOverseerCommand(snapshot, fullProductMode) {
  const slices = sliceRecordsFromSnapshot(snapshot);
  const active = slices.find((slice) => !["accepted", "closed"].includes(slice.status));
  if (active) {
    const dashboard = isDashboardSliceRecord(active);
    const actor = dashboard ? "live-dashboard-worker" : "live-backend-worker";
    const reviewer = dashboard ? "live-dashboard-reviewer" : "live-reviewer";
    if (active.status === "ready" || active.status === "repairing" || active.status === "blocked") {
      return {
        focus: dashboard ? "dashboard" : "backend",
        summary: dashboard
          ? \`Fake live overseer dispatches dashboard worker for \${active.id}.\`
          : \`Fake live overseer dispatches backend worker for \${active.id}.\`,
        currentPriority: dashboard
          ? "Implement the runnable invoice dashboard after backend acceptance."
          : "Move the backend slice through worker and reviewer gates.",
        command: {
          command: \`node "\${cli}" run \${active.id} --actor \${actor} --driver codex\`,
          purpose: dashboard
            ? "Dispatch the dashboard worker against the full-product UI slice."
            : "Dispatch the backend worker against the active meaningful invoice slice.",
          expectedStateChange: "The slice gains worker evidence and implementation status.",
          requiresHuman: false
        }
      };
    }
    return {
      focus: dashboard ? "dashboard" : "backend",
      summary: dashboard
        ? \`Fake live overseer dispatches dashboard reviewer for \${active.id}.\`
        : \`Fake live overseer dispatches backend reviewer for \${active.id}.\`,
      currentPriority: dashboard
        ? "Review dashboard product coherence before deterministic verification."
        : "Review backend capability evidence before deterministic verification.",
      command: {
        command: \`node "\${cli}" review \${active.id} --actor \${reviewer} --driver codex\`,
        purpose: "Dispatch the independent reviewer after worker evidence exists.",
        expectedStateChange: "The slice gains review evidence and becomes ready for deterministic verification.",
        requiresHuman: false
      }
    };
  }

  const backendAccepted = slices.some((slice) => slice.status === "accepted" && isBackendSliceRecord(slice));
  const dashboardAccepted = slices.some((slice) => slice.status === "accepted" && isDashboardSliceRecord(slice));
  if (!backendAccepted) {
    return {
      focus: "backend",
      summary: "Fake live overseer creates the backend capability slice.",
      currentPriority: "Create accepted backend invoice capability before dashboard work.",
      blockers: fullProductMode
        ? [dashboardDependencyWarning(), dashboardDependencyWarningRealWording(), dashboardHistoricalDependencyWarning()]
        : [],
      command: {
        command: \`node "\${cli}" slices pull --target invoice-api --source invoice-api.md --new-lane --lane-name "Backend Lane: Invoice Query Core" --lane-purpose "Implement accepted invoice backend capabilities before dashboard slices" --lane-labels backend,invoice-api,live-smoke --orchestrator live-overseer --batch-size \${fullProductMode ? 7 : 3}\`,
        purpose: "Serve a real backend work package with immutable FR/AC refs.",
        expectedStateChange: "A backend lane and slice are created with active leases.",
        requiresHuman: false
      }
    };
  }
  if (!dashboardAccepted) {
    return {
      focus: "dashboard",
      summary: "Fake live overseer creates the dashboard product slice after backend acceptance.",
      currentPriority: "Create the dashboard product slice and make the local product runnable.",
      command: {
        command: \`node "\${cli}" slices pull --target invoice-dashboard --source invoice-dashboard.md --new-lane --lane-name "Dashboard Lane: Invoice Operations Product" --lane-purpose "Implement runnable invoice dashboard product after backend acceptance" --lane-labels frontend,dashboard,invoice-product,live-smoke --orchestrator live-overseer --batch-size 3\`,
        purpose: "Serve the dashboard work only after backend capability acceptance.",
        expectedStateChange: "A dashboard lane and UI slice are created with active leases.",
        requiresHuman: false
      }
    };
  }
  return {
    focus: "dashboard",
    summary: "Fake live overseer has no further commands; product readiness should decide final status.",
    currentPriority: "Wait for product readiness.",
    command: {
      command: \`node "\${cli}" observe --events 160\`,
      purpose: "Confirm final product readiness state.",
      expectedStateChange: "Snapshot remains stable for final readiness.",
      requiresHuman: false
    }
  };
}

function sliceRecordsFromSnapshot(snapshot) {
  if (Array.isArray(snapshot?.slices) && snapshot.slices.length > 0) return snapshot.slices;
  const records = [
    ...(Array.isArray(snapshot?.actionableState?.activeSliceQueue) ? snapshot.actionableState.activeSliceQueue : []),
    ...(Array.isArray(snapshot?.sliceSummary?.active) ? snapshot.sliceSummary.active : []),
    ...(Array.isArray(snapshot?.sliceSummary?.recentAccepted) ? snapshot.sliceSummary.recentAccepted : []),
  ];
  return [...new Map(records.map((record) => [record.id, record])).values()];
}

function isBackendSliceRecord(slice) {
  return Array.isArray(slice.frAcRefs) && slice.frAcRefs.some((ref) => String(ref).startsWith("AC-INV"));
}

function isDashboardSliceRecord(slice) {
  return Array.isArray(slice.frAcRefs) && slice.frAcRefs.some((ref) =>
    String(ref).startsWith("AC-UI") || String(ref).startsWith("AC-PROD")
  );
}

function writeDashboardImplementation(options = {}) {
  const omitStart = Boolean(options.omitStart);
  const packageJson = {
    name: "invoice-dashboard-fixture",
    version: "0.1.0",
    type: "module",
    scripts: {
      test: "node --test"
    }
  };
  if (!omitStart) packageJson.scripts.start = "node src/server.js";
  fs.writeFileSync(path.join(process.cwd(), "package.json"), JSON.stringify(packageJson, null, 2) + "\\n", "utf8");

  fs.writeFileSync(path.join(process.cwd(), "src", "dashboard.js"), \`const seedInvoices = [
  { id: "INV-1001", customerId: "CUST-1", status: "open", totalCents: 12500, issuedOn: "2026-05-01", dueOn: "2026-06-20", description: "Platform subscription" },
  { id: "INV-1002", customerId: "CUST-1", status: "paid", totalCents: 9900, issuedOn: "2026-04-10", dueOn: "2026-05-10", description: "Implementation support" },
  { id: "INV-1003", customerId: "CUST-2", status: "overdue", totalCents: 4500, issuedOn: "2026-03-01", dueOn: "2026-04-01", description: "Usage overage" },
  { id: "INV-1004", customerId: "CUST-3", status: "open", totalCents: 7300, issuedOn: "2026-05-12", dueOn: "2026-06-25", description: "Advisory retainer" },
  { id: "INV-1005", customerId: "CUST-2", status: "paid", totalCents: 3100, issuedOn: "2026-04-20", dueOn: "2026-05-20", description: "Data cleanup" }
];

const customers = [
  { id: "CUST-1", displayName: "Aster Labs" },
  { id: "CUST-2", displayName: "Northwind Field Ops" },
  { id: "CUST-3", displayName: "Bluebird Systems" }
];

let invoices = seedInvoices.map((invoice) => ({ ...invoice }));

export function resetInvoices() {
  invoices = seedInvoices.map((invoice) => ({ ...invoice }));
}

export function listInvoices(filters = {}) {
  return invoices
    .filter((invoice) => !filters.status || invoice.status === filters.status)
    .filter((invoice) => !filters.customerId || invoice.customerId === filters.customerId)
    .map(withCustomer)
    .sort((left, right) => left.dueOn.localeCompare(right.dueOn) || left.id.localeCompare(right.id));
}

export function getInvoice(id) {
  const invoice = invoices.find((item) => item.id === id);
  return invoice ? withCustomer(invoice) : undefined;
}

export function getSummary() {
  const open = invoices.filter((invoice) => invoice.status === "open");
  const overdue = invoices.filter((invoice) => invoice.status === "overdue");
  const paid = invoices.filter((invoice) => invoice.status === "paid");
  return {
    invoiceCount: invoices.length,
    openCount: open.length,
    overdueCount: overdue.length,
    paidCount: paid.length,
    openTotalCents: open.reduce((total, invoice) => total + invoice.totalCents, 0),
    overdueTotalCents: overdue.reduce((total, invoice) => total + invoice.totalCents, 0)
  };
}

export function markInvoicePaid(id) {
  const invoice = invoices.find((item) => item.id === id);
  if (!invoice) return undefined;
  if (invoice.status !== "paid") invoice.status = "paid";
  return withCustomer(invoice);
}

export function getDashboardModel(filters = {}) {
  const visibleInvoices = listInvoices(filters);
  return {
    title: "Invoice Operations Dashboard",
    summaryCards: getSummary(),
    invoices: visibleInvoices,
    openInvoiceIds: listInvoices({ status: "open" }).map((invoice) => invoice.id),
    featuredInvoice: getInvoice(visibleInvoices[0]?.id || "INV-1001")
  };
}

export function formatCurrency(cents) {
  return "$" + (cents / 100).toFixed(2);
}

function withCustomer(invoice) {
  const customer = customers.find((item) => item.id === invoice.customerId);
  return { ...invoice, customerDisplayName: customer?.displayName || "Unknown customer" };
}
\`, "utf8");

  if (!omitStart) {
  fs.writeFileSync(path.join(process.cwd(), "src", "server.js"), \`import http from "node:http";
import { getDashboardModel, getInvoice, getSummary, listInvoices, markInvoicePaid, formatCurrency } from "./dashboard.js";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4321);

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://localhost");
  if (request.method === "GET" && url.pathname === "/") {
    const model = getDashboardModel();
    sendHtml(response, renderDashboard(model));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/summary") {
    sendJson(response, getSummary());
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/invoices") {
    sendJson(response, listInvoices({ status: url.searchParams.get("status") || undefined, customerId: url.searchParams.get("customerId") || undefined }));
    return;
  }
  const invoiceMatch = /^\\\\/api\\\\/invoices\\\\/([^/]+)$/.exec(url.pathname);
  const statusMatch = /^\\\\/api\\\\/invoices\\\\/([^/]+)\\\\/status$/.exec(url.pathname);
  if (request.method === "GET" && invoiceMatch) {
    const invoice = getInvoice(invoiceMatch[1]);
    if (!invoice) {
      sendJson(response, { error: "invoice_not_found" }, 404);
      return;
    }
    sendJson(response, invoice);
    return;
  }
  if (request.method === "PATCH" && statusMatch) {
    const invoice = markInvoicePaid(statusMatch[1]);
    if (!invoice) {
      sendJson(response, { error: "invoice_not_found" }, 404);
      return;
    }
    sendJson(response, invoice);
    return;
  }
  sendJson(response, { error: "not_found" }, 404);
});

server.listen(port, host, () => {
  console.log("Invoice Operations Dashboard listening at http://" + host + ":" + port);
});

function renderDashboard(model) {
  const rows = model.invoices.map((invoice) => "<tr><td>" + invoice.id + "</td><td>" + invoice.customerDisplayName + "</td><td>" + invoice.status + "</td><td>" + invoice.dueOn + "</td><td>" + formatCurrency(invoice.totalCents) + "</td></tr>").join("");
  return "<!doctype html><html><head><title>Invoice Operations Dashboard</title></head><body><h1>Invoice Operations Dashboard</h1><section id='summary'><div>Total invoices: " + model.summaryCards.invoiceCount + "</div><div>Open total: " + formatCurrency(model.summaryCards.openTotalCents) + "</div><div>Overdue total: " + formatCurrency(model.summaryCards.overdueTotalCents) + "</div></section><table><tbody>" + rows + "</tbody></table></body></html>";
}

function sendJson(response, payload, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function sendHtml(response, html) {
  response.writeHead(200, { "content-type": "text/html" });
  response.end(html);
}
\`, "utf8");
  }

  fs.writeFileSync(path.join(process.cwd(), "test", "dashboard.test.js"), \`import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getDashboardModel, getInvoice, getSummary, listInvoices, markInvoicePaid, resetInvoices } from "../src/dashboard.js";

beforeEach(() => resetInvoices());

test("dashboard model includes summary cards and open invoice ids", () => {
  const model = getDashboardModel();
  assert.equal(model.title, "Invoice Operations Dashboard");
  assert.equal(model.summaryCards.invoiceCount, 5);
  assert.deepEqual(model.openInvoiceIds, ["INV-1001", "INV-1004"]);
});

test("filters invoice rows by status and customer", () => {
  assert.deepEqual(listInvoices({ status: "overdue" }).map((invoice) => invoice.id), ["INV-1003"]);
  assert.deepEqual(listInvoices({ customerId: "CUST-1" }).map((invoice) => invoice.id), ["INV-1002", "INV-1001"]);
});

test("returns invoice detail with customer display name", () => {
  assert.equal(getInvoice("INV-1001").customerDisplayName, "Aster Labs");
  assert.equal(getInvoice("missing"), undefined);
});

test("mark paid updates summary state", () => {
  assert.equal(getSummary().overdueCount, 1);
  const updated = markInvoicePaid("INV-1003");
  assert.equal(updated.status, "paid");
  assert.equal(getSummary().overdueCount, 0);
  assert.equal(getSummary().paidCount, 3);
});
\`, "utf8");
}

function incrementCounter(filePath) {
  const current = fs.existsSync(filePath) ? Number.parseInt(fs.readFileSync(filePath, "utf8"), 10) : 0;
  const next = Number.isFinite(current) ? current + 1 : 1;
  fs.writeFileSync(filePath, String(next), "utf8");
  return next;
}
`,
    "utf8",
  );
  return scriptPath;
}
