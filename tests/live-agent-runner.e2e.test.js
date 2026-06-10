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
    `import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
const schemaIndex = args.indexOf("--output-schema");
const schemaPath = schemaIndex >= 0 ? args[schemaIndex + 1] : "";
const refs = ["AC-INV-001.1", "AC-INV-001.2", "AC-INV-001.3"];
const cli = process.env.TEST_SWARM_CLI;
const fault = process.env.SWARM_LIVE_FAULT || "none";
const workerCountPath = ${JSON.stringify(workerCountPath)};
const reviewCountPath = ${JSON.stringify(reviewCountPath)};

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
  const promptPath = parsePromptPath(args.at(-1) ?? "");
  const prompt = promptPath && fs.existsSync(promptPath) ? fs.readFileSync(promptPath, "utf8") : "";
  const currentSlice = findCurrentSlice(prompt);
  const command = chooseOverseerCommand(currentSlice);
  if (outputPath) {
    fs.writeFileSync(outputPath, JSON.stringify({
      status: "recommend_commands",
      summary: currentSlice
        ? "Fake live overseer continues the active backend slice."
        : "Fake live overseer creates the first backend capability slice.",
      scenario: "live-agent-smoke",
      currentPriority: currentSlice
        ? "Move the backend slice through worker and reviewer gates."
        : "Create a backend invoice capability slice before dashboard work.",
      recommendedCommands: [command, {
        command: \`node "\${cli}" observe --events 160\`,
        purpose: "Refresh visible state after this overseer action.",
        expectedStateChange: "Snapshot shows the latest lane, slice, agents, and evidence.",
        requiresHuman: false
      }],
      lanePlan: [{
        laneName: "Backend Lane: Invoice Query Core",
        purpose: "Complete backend invoice query behavior before dashboard work.",
        nextAction: command.purpose
      }],
      blockers: [],
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
        summary: "fake reviewer accepted live-runner backend slice",
        frAcFindings: refs.map((ref) => ({
          ref,
          status: "passed",
          evidence: ["fake-review-evidence"],
          finding: "Worker evidence and runtime changes cover this ref."
        })),
        testAssessment: "Worker evidence includes behavior-focused invoice query tests.",
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

export function getInvoiceSummary() {
  return { count: invoices.length };
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

export function getInvoiceSummary() {
  return { count: invoices.length };
}
\`, "utf8");
  fs.writeFileSync(path.join(process.cwd(), "test", "invoices.test.js"), \`import test from "node:test";
import assert from "node:assert/strict";
import { getInvoiceSummary, listInvoices } from "../src/invoices.js";

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

test("returns baseline invoice count summary", () => {
  assert.deepEqual(getInvoiceSummary(), { count: 3 });
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

console.log(JSON.stringify({ type: "turn.completed" }));

function parsePromptPath(value) {
  const separator = value.lastIndexOf(": ");
  return separator >= 0 ? value.slice(separator + 2).trim() : undefined;
}

function findCurrentSlice(prompt) {
  const matches = [...prompt.matchAll(/"id": "(SLICE-[^"]+)"[\\s\\S]{0,2000}?"status": "(ready_for_review|implemented|ready|repairing|blocked|accepted)"/g)];
  return matches.length > 0 ? { id: matches[0][1], status: matches[0][2] } : undefined;
}

function chooseOverseerCommand(slice) {
  if (!slice) {
    return {
      command: \`node "\${cli}" slices pull --target invoice-api --source invoice-api.md --new-lane --lane-name "Backend Lane: Invoice Query Core" --lane-purpose "Implement accepted invoice backend capabilities before dashboard slices" --lane-labels backend,invoice-api,live-smoke --orchestrator live-overseer --batch-size 3\`,
      purpose: "Serve a real backend work package with immutable FR/AC refs.",
      expectedStateChange: "A backend lane and slice are created with active leases.",
      requiresHuman: false
    };
  }
  if (slice.status === "ready" || slice.status === "repairing" || slice.status === "blocked") {
    return {
      command: \`node "\${cli}" run \${slice.id} --actor live-backend-worker --driver codex\`,
      purpose: "Dispatch the backend worker against the active meaningful invoice slice.",
      expectedStateChange: "The backend slice gains worker evidence and implementation status.",
      requiresHuman: false
    };
  }
  return {
    command: \`node "\${cli}" review \${slice.id} --actor live-reviewer --driver codex\`,
    purpose: "Dispatch the independent reviewer after worker evidence exists.",
    expectedStateChange: "The backend slice gains review evidence and becomes ready for deterministic verification.",
    requiresHuman: false
  };
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
