#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { refreshCheckpoint } from "../dist/checkpoints.js";
import { createEvent } from "../dist/events.js";
import { makeId } from "../dist/ids.js";
import { SwarmStore } from "../dist/storage.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const driver = args.driver ?? "codex";
if (!["fixture", "codex"].includes(driver)) {
  throw new Error(`Invalid --driver ${driver}; expected fixture or codex`);
}

const defaultWorkspace = path.join(repoRoot, ".swarm-demo", "live-agent-smoke");
const workspace = path.resolve(args.workspace ?? defaultWorkspace);
const resetBeforeRun = args.reset === "true";
const scenario = args.scenario ?? "live-agent-smoke";
const maxTurns = Number.parseInt(args["max-turns"] ?? "8", 10);
const executeLimit = Number.parseInt(args["execute-limit"] ?? "3", 10);
const maxRuntimeSeconds = Number.parseInt(args["max-runtime-seconds"] ?? "600", 10);
const maxSlices = Number.parseInt(args["max-slices"] ?? "5", 10);
const maxAgentRuns = Number.parseInt(args["max-agent-runs"] ?? "12", 10);
const faultMode = args.fault ?? "none";
if (!["none", "source-mutation", "reviewer-repair", "stale-run", "context-handoff", "low-signal"].includes(faultMode)) {
  throw new Error(
    `Invalid --fault ${faultMode}; expected none, source-mutation, reviewer-repair, stale-run, context-handoff, or low-signal`,
  );
}
const runPhase = faultMode === "none" ? "phase-5c-autonomous-acceptance-loop" : "phase-6-fault-injection";
const cli = path.join(repoRoot, "dist", "cli.js");
const resetScript = path.join(repoRoot, "scripts", "reset-live-agent-smoke.mjs");
const invoiceTemplate = path.join(repoRoot, "fixtures", "templates", "invoice-api");
const dashboardTemplate = path.join(repoRoot, "fixtures", "templates", "invoice-dashboard");
const sourceProductSpec = path.join(repoRoot, "docs", "requirements", "live-smoke-invoice-dashboard-product-spec.md");

const invoiceTarget = path.join(workspace, "invoice-api");
const dashboardTarget = path.join(workspace, "invoice-dashboard");
const productSpec = path.join(workspace, "source-specs", "live-smoke-invoice-dashboard-product-spec.md");
const invoiceSpec = path.join(invoiceTarget, "specs", "invoice-api.md");
const dashboardSpec = path.join(dashboardTarget, "specs", "invoice-dashboard.md");
const manifestPath = path.join(workspace, "live-agent-smoke.json");
const summaryPath = path.resolve(args.summary ?? path.join(workspace, "live-agent-run-summary.json"));
const artifactsPath = path.resolve(args.artifacts ?? path.join(workspace, "live-agent-run-artifacts"));
const historyRoot = path.resolve(args["history-root"] ?? path.join(repoRoot, ".swarm-demo", "live-agent-run-history"));
const historyEnabled = args.history !== "false";
const scenarioEntityId = `scenario:${scenario}`;
const runStartedAt = new Date().toISOString();
const runId = sanitizeRunId(args["run-id"] ?? `LAR-${compactTimestamp(runStartedAt)}-${scenario}-${faultMode}-${process.pid}`);

assertApprovedWorkspace(workspace);
if (historyEnabled) assertApprovedHistoryRoot(historyRoot, workspace);
if (!fs.existsSync(cli)) throw new Error(`Built CLI not found: ${cli}. Run npm run build first.`);
if (resetBeforeRun || !fs.existsSync(path.join(workspace, ".swarm", "state.db"))) {
  resetScenario();
}
ensureWorkspaceInitialized();

runSwarm(["run-mode", "set", "live-agent-smoke"]);
updateManifest({
  phase: runPhase,
  runMode: "live-agent-smoke",
});

fs.mkdirSync(artifactsPath, { recursive: true });
const injectedFaults = injectConfiguredFault();
const staleRecovery = {
  staleRunId: "RUN-live-stale-001",
  sliceId: undefined,
  injectedAtTurn: undefined,
  markedAtTurn: undefined,
  restartedAtTurn: undefined,
  scanOutputPath: undefined,
  markOutputPath: undefined,
  restartOutputPath: undefined,
  restartActor: "live-recovery-worker",
};
const contextHandoff = {
  sliceId: undefined,
  laneId: undefined,
  workerRunId: undefined,
  generatedAtTurn: undefined,
  checkpointIds: {},
  packetPaths: {},
  checkpointOutputPaths: {},
};
const lowSignal = {
  sliceId: undefined,
  laneId: undefined,
  injectedAtTurn: undefined,
  escalationId: undefined,
  checkpointId: undefined,
  warningPath: undefined,
};

const startedAt = Date.now();
const turns = [];
const verifyRuns = [];
const repairClearances = [];
const staleRecoveryClearances = [];
let finalOutcome = undefined;
let finalReason = undefined;
let finalSliceId = undefined;

for (let turn = 1; turn <= maxTurns; turn += 1) {
  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  if (elapsedSeconds > maxRuntimeSeconds) {
    finalOutcome = "blocked";
    finalReason = `Max runtime exceeded: ${elapsedSeconds}s > ${maxRuntimeSeconds}s.`;
    raiseScenarioEscalation("blocker", finalReason);
    break;
  }

  const before = observe(200);
  const sourceMutations = inspectSourceMutations(before.sources);
  if (sourceMutations.some((item) => item.mutated)) {
    finalOutcome = "human_required";
    finalReason = "Immutable source mutation detected during live acceptance loop.";
    raiseScenarioEscalation("human_required", finalReason);
    break;
  }

  if (before.slices.length > maxSlices) {
    finalOutcome = "blocked";
    finalReason = `Max slices exceeded: ${before.slices.length} > ${maxSlices}.`;
    raiseScenarioEscalation("blocker", finalReason);
    break;
  }
  if (before.agentRuns.length > maxAgentRuns) {
    finalOutcome = "blocked";
    finalReason = `Max agent runs exceeded: ${before.agentRuns.length} > ${maxAgentRuns}.`;
    raiseScenarioEscalation("blocker", finalReason);
    break;
  }

  const staleAction = handleStaleRunFault(turn, before);
  if (staleAction) {
    turns.push(staleAction);
    continue;
  }

  const contextHandoffAction = handleContextHandoffFault(turn, before);
  if (contextHandoffAction) {
    turns.push(contextHandoffAction);
    continue;
  }

  const lowSignalAction = handleLowSignalFault(turn, before);
  if (lowSignalAction) {
    turns.push(lowSignalAction);
    continue;
  }

  const acceptedSlice = before.slices.find((slice) => slice.status === "accepted");
  if (acceptedSlice) {
    finalOutcome = "accepted";
    finalReason = `Slice ${acceptedSlice.id} is accepted.`;
    finalSliceId = acceptedSlice.id;
    break;
  }

  const readyForVerify = before.slices.find((slice) => isReadyForDeterministicVerify(slice));
  if (readyForVerify) {
    const clearedEscalations = clearResolvedRepairEscalations(readyForVerify.id, before.activeEscalations, turn);
    const clearedRecoveryEscalations = clearResolvedStaleRecoveryEscalations(readyForVerify.id, before.activeEscalations, turn);
    if (clearedEscalations.length > 0) {
      repairClearances.push(...clearedEscalations);
    }
    if (clearedRecoveryEscalations.length > 0) {
      staleRecoveryClearances.push(...clearedRecoveryEscalations);
    }
    const allClearedEscalations = [...clearedEscalations, ...clearedRecoveryEscalations];
    const output = runSwarm(["verify", readyForVerify.id, "--actor", `live-deterministic-verifier-${turn}`, "--force"]);
    const outputPath = path.join(artifactsPath, `turn-${turn}-verify-output.txt`);
    fs.writeFileSync(outputPath, output, "utf8");
    const afterVerify = observe(220);
    const verifiedSlice = afterVerify.slices.find((slice) => slice.id === readyForVerify.id);
    verifyRuns.push({
      turn,
      sliceId: readyForVerify.id,
      outputPath,
      statusAfter: verifiedSlice?.status,
      accepted: verifiedSlice?.status === "accepted",
      clearedEscalations: allClearedEscalations,
    });
    turns.push({
      turn,
      kind: "verify",
      sliceId: readyForVerify.id,
      outputPath,
      statusAfter: verifiedSlice?.status,
      clearedEscalations: allClearedEscalations,
    });
    if (verifiedSlice?.status === "accepted") {
      finalOutcome = "accepted";
      finalReason = `Slice ${readyForVerify.id} passed reviewer and deterministic verification gates.`;
      finalSliceId = readyForVerify.id;
      break;
    }
    finalOutcome = hasHumanRequired(afterVerify) ? "human_required" : "blocked";
    finalReason = `Deterministic verification did not accept ${readyForVerify.id}; final status is ${verifiedSlice?.status ?? "unknown"}.`;
    if (finalOutcome !== "accepted") raiseScenarioEscalation(finalOutcome, finalReason);
    finalSliceId = readyForVerify.id;
    break;
  }

  const output = runSwarm([
    "orchestrate",
    "--actor",
    "live-overseer",
    "--driver",
    driver,
    "--scenario",
    scenario,
    "--execute",
    "--execute-limit",
    String(executeLimit),
  ]);
  const outputPath = path.join(artifactsPath, `turn-${turn}-overseer-output.txt`);
  fs.writeFileSync(outputPath, output, "utf8");
  const after = observe(220);
  const latestOverseerRun = after.agentRuns.filter((run) => run.role === "overseer" && run.entityId === scenarioEntityId).at(-1);
  const latestCommands = after.recentEvents
    .filter((event) => event.type === "overseer.commands_completed" && event.payload?.runId === latestOverseerRun?.id)
    .at(-1);
  turns.push({
    turn,
    kind: "overseer",
    outputPath,
    runId: latestOverseerRun?.id,
    decisionPath: latestOverseerRun?.resultPath,
    commandSummary: latestCommands?.payload,
    sliceStatuses: after.slices.map((slice) => ({ id: slice.id, status: slice.status, refs: slice.frAcRefs })),
  });

  if (hasHumanRequired(after)) {
    finalOutcome = "human_required";
    finalReason = "A human-required or critical escalation is active.";
    break;
  }
  const latestCommandSummary = latestCommands?.payload;
  if (
    latestCommandSummary &&
    latestCommandSummary.executed === 0 &&
    (latestCommandSummary.blocked > 0 || latestCommandSummary.failed > 0)
  ) {
    finalOutcome = "blocked";
    finalReason = "Overseer command execution made no progress and reported blocked/failed commands.";
    raiseScenarioEscalation("blocker", finalReason);
    break;
  }
}

if (!finalOutcome) {
  finalOutcome = "blocked";
  finalReason = `Max turns reached without acceptance: ${maxTurns}.`;
  raiseScenarioEscalation("blocker", finalReason);
}

const finalSnapshot = observe(260);
const finalSourceMutations = inspectSourceMutations(finalSnapshot.sources);
const graph = JSON.parse(runSwarm(["graph", "--format", "json"]));
const acceptedSlice = finalSnapshot.slices.find((slice) => slice.status === "accepted");
const selectedSliceId = finalSliceId ?? acceptedSlice?.id ?? finalSnapshot.slices[0]?.id;
const report = selectedSliceId ? runSwarm(["report", selectedSliceId]) : "";
const timeline = selectedSliceId ? JSON.parse(runSwarm(["timeline", selectedSliceId, "--json"])) : { items: [] };

const snapshotPath = path.join(artifactsPath, "observe.json");
const graphPath = path.join(artifactsPath, "graph.json");
const reportPath = path.join(artifactsPath, "slice-report.md");
const timelinePath = path.join(artifactsPath, "timeline.json");
const artifactIndexPath = path.join(artifactsPath, "artifact-index.json");
const artifactIndexMarkdownPath = path.join(artifactsPath, "artifact-index.md");
const historyPaths = historyEnabled ? buildHistoryPaths(runId) : undefined;
fs.writeFileSync(snapshotPath, `${JSON.stringify(finalSnapshot, null, 2)}\n`, "utf8");
fs.writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
fs.writeFileSync(reportPath, report, "utf8");
fs.writeFileSync(timelinePath, `${JSON.stringify(timeline, null, 2)}\n`, "utf8");

const finalSlice = selectedSliceId ? finalSnapshot.slices.find((slice) => slice.id === selectedSliceId) : undefined;
const workerRuns = finalSnapshot.agentRuns.filter((run) => run.role === "worker" && run.sliceId === selectedSliceId);
const reviewerRuns = finalSnapshot.agentRuns.filter((run) => run.role === "reviewer" && run.sliceId === selectedSliceId);
const workerRun = workerRuns.at(-1);
const reviewerRun = reviewerRuns.at(-1);
const commandEvidence = finalSlice?.evidence.filter((item) => item.kind === "command").at(-1);
const reviewEvidence = finalSlice?.evidence.filter((item) => item.kind === "review_result").at(-1);
const staleRun = finalSnapshot.agentRuns.find((run) => run.id === staleRecovery.staleRunId);
const staleRestartRun = staleRecovery.sliceId
  ? finalSnapshot.agentRuns.find(
      (run) =>
        run.sliceId === staleRecovery.sliceId &&
        run.id !== staleRecovery.staleRunId &&
        run.role === "worker" &&
        run.status === "completed",
    )
  : undefined;
const staleRunEscalationActive = finalSnapshot.activeEscalations.some(
  (item) => item.entityType === "slice" && item.entityId === staleRecovery.sliceId && item.message.includes(staleRecovery.staleRunId),
);
const contextHandoffSlice = contextHandoff.sliceId ? finalSnapshot.slices.find((slice) => slice.id === contextHandoff.sliceId) : undefined;
const contextHandoffReviewerRuns = contextHandoff.sliceId
  ? finalSnapshot.agentRuns.filter((run) => run.sliceId === contextHandoff.sliceId && run.role === "reviewer")
  : [];
const contextHandoffPackets = contextHandoffPacketAssertions();
const lowSignalWarning = lowSignal.escalationId
  ? finalSnapshot.activeEscalations.find((item) => item.id === lowSignal.escalationId)
  : undefined;
const lowSignalEvent = finalSnapshot.recentEvents.find(
  (event) => event.type === "planner.low_signal_work" && event.payload?.faultMode === "low-signal",
);
const lowSignalCheckpoint = lowSignal.laneId
  ? finalSnapshot.checkpoints.find(
      (checkpoint) =>
        checkpoint.role === "planner" && checkpoint.entityType === "lane" && checkpoint.entityId === lowSignal.laneId,
    )
  : undefined;
const outcomeClassification = classifyOutcome({
  finalOutcome,
  finalReason,
  faultMode,
  finalSnapshot,
  finalSlice,
  verifyRuns,
  turns,
  staleRecovery,
  finalSourceMutations,
});
const artifactPaths = {
  summary: summaryPath,
  snapshot: snapshotPath,
  graph: graphPath,
  report: reportPath,
  timeline: timelinePath,
  workerEvents: workerRun?.eventsPath,
  workerResult: workerRun?.resultPath,
  reviewerEvents: reviewerRun?.eventsPath,
  reviewerResult: reviewerRun?.resultPath,
  verificationOutput: verifyRuns.at(-1)?.outputPath,
  recoveryScan: staleRecovery.scanOutputPath,
  recoveryMark: staleRecovery.markOutputPath,
  recoveryRestart: staleRecovery.restartOutputPath,
  contextWorkerPacket: contextHandoff.packetPaths.worker,
  contextReviewerPacket: contextHandoff.packetPaths.reviewer,
  contextVerifierPacket: contextHandoff.packetPaths.verifier,
  contextOverseerPacket: contextHandoff.packetPaths.overseer,
  contextRecoveryPacket: contextHandoff.packetPaths.recovery,
  lowSignalWarning: lowSignal.warningPath,
  artifactIndex: artifactIndexPath,
  artifactIndexMarkdown: artifactIndexMarkdownPath,
};

const summary = {
  runId,
  workspace,
  driver,
  runMode: finalSnapshot.runMode,
  startedAt: runStartedAt,
  generatedAt: new Date().toISOString(),
  phase: runPhase,
  scenario,
  fault: {
    mode: faultMode,
    injected: injectedFaults,
  },
  finalOutcome,
  finalReason,
  outcomeClassification,
  sliceId: selectedSliceId,
  finalSliceStatus: finalSlice?.status,
  limits: {
    maxTurns,
    maxSlices,
    maxAgentRuns,
    maxRuntimeSeconds,
    executeLimit,
  },
  counts: {
    turns: turns.length,
    verifyRuns: verifyRuns.length,
    targets: finalSnapshot.targets.length,
    sources: finalSnapshot.sources.length,
    lanes: finalSnapshot.lanes.length,
    slices: finalSnapshot.slices.length,
    agentRuns: finalSnapshot.agentRuns.length,
    evidence: finalSlice?.evidence.length ?? 0,
    activeEscalations: finalSnapshot.activeEscalations.length,
    graphNodes: graph.nodes.length,
    graphEdges: graph.edges.length,
    timelineItems: timeline.items.length,
  },
  turns,
  verifyRuns,
  repairClearances,
  staleRecoveryClearances,
  staleRecovery: faultMode === "stale-run" ? staleRecovery : undefined,
  contextHandoff: faultMode === "context-handoff" ? contextHandoff : undefined,
  lowSignal: faultMode === "low-signal" ? lowSignal : undefined,
  runs: {
    overseers: finalSnapshot.agentRuns.filter((run) => run.role === "overseer" && run.entityId === scenarioEntityId),
    workers: workerRuns,
    reviewers: reviewerRuns,
    worker: workerRun,
    reviewer: reviewerRun,
  },
  review: finalSlice?.reviewResult,
  sourceMutations: finalSourceMutations,
  history: historyPaths
    ? {
        enabled: true,
        ...historyPaths,
      }
    : { enabled: false },
  assertions: {
    runIdRecorded: Boolean(runId),
    runModeIsLive: finalSnapshot.runMode === "live-agent-smoke",
    faultInjected: faultMode === "none" || injectedFaults.length > 0,
    faultDetected:
      faultMode === "none" ||
      (faultMode === "source-mutation" && finalSourceMutations.some((item) => item.mutated)) ||
      (faultMode === "reviewer-repair" && finalSnapshot.recentEvents.some((event) => event.type === "review.blocked_acceptance")) ||
      (faultMode === "stale-run" &&
        staleRun?.status === "stale" &&
        finalSnapshot.recentEvents.some((event) => event.type === "recovery.marked_stale_run")) ||
      (faultMode === "context-handoff" &&
        Boolean(contextHandoff.generatedAtTurn) &&
        finalSnapshot.recentEvents.some(
          (event) => event.type === "checkpoint.refreshed" && event.actor === "live-context-handoff",
        )) ||
      (faultMode === "low-signal" && Boolean(lowSignalWarning) && Boolean(lowSignalEvent)),
    sourceMutationStoppedBeforeHiddenWork: faultMode !== "source-mutation" || finalSnapshot.agentRuns.length === 0,
    reviewerRepairLoopExercised:
      faultMode !== "reviewer-repair" ||
      (workerRuns.length >= 2 &&
        reviewerRuns.length >= 2 &&
        finalSnapshot.recentEvents.some((event) => event.type === "review.blocked_acceptance")),
    reviewerRepairEscalationCleared: faultMode !== "reviewer-repair" || repairClearances.length > 0,
    staleRunRecoveryLoopExercised:
      faultMode !== "stale-run" ||
      Boolean(
        staleRun?.status === "stale" &&
          staleRestartRun?.status === "completed" &&
          staleRecovery.injectedAtTurn &&
          staleRecovery.markedAtTurn &&
          staleRecovery.restartedAtTurn &&
          finalSnapshot.recentEvents.some((event) => event.type === "recovery.restart_completed"),
      ),
    staleRunEscalationCleared: faultMode !== "stale-run" || staleRecoveryClearances.length > 0,
    staleRunBlockerNotActiveAfterAcceptance:
      faultMode !== "stale-run" || finalOutcome !== "accepted" || !staleRunEscalationActive,
    contextHandoffPacketsGenerated:
      faultMode !== "context-handoff" ||
      Boolean(
        contextHandoff.generatedAtTurn &&
          contextHandoffPackets.worker &&
          contextHandoffPackets.reviewer &&
          contextHandoffPackets.verifier &&
          contextHandoffPackets.overseer &&
          contextHandoffPackets.recovery,
      ),
    contextHandoffCheckpointsVisible:
      faultMode !== "context-handoff" ||
      ["worker", "reviewer", "verifier"].every((role) =>
        finalSnapshot.checkpoints.some(
          (checkpoint) =>
            checkpoint.role === role &&
            checkpoint.entityType === "slice" &&
            checkpoint.entityId === contextHandoff.sliceId,
        ),
      ),
    contextHandoffContinuedAfterPacket:
      faultMode !== "context-handoff" ||
      Boolean(
        contextHandoffSlice?.status === "accepted" &&
          contextHandoffReviewerRuns.length > 0 &&
          verifyRuns.some((run) => run.turn > contextHandoff.generatedAtTurn && run.accepted),
      ),
    lowSignalWarningVisible:
      faultMode !== "low-signal" ||
      Boolean(
        lowSignalWarning?.level === "warning" &&
          lowSignalWarning.entityType === "lane" &&
          lowSignalWarning.message.includes("Low-signal slice cadence detected"),
      ),
    lowSignalEventVisible: faultMode !== "low-signal" || Boolean(lowSignalEvent),
    lowSignalCheckpointVisible: faultMode !== "low-signal" || Boolean(lowSignalCheckpoint),
    lowSignalDoesNotBypassVerification:
      faultMode !== "low-signal" ||
      Boolean(verifyRuns.some((run) => run.turn > lowSignal.injectedAtTurn && run.accepted) && finalSlice?.status === "accepted"),
    overseerRan:
      faultMode === "source-mutation" ||
      finalSnapshot.agentRuns.some((run) => run.role === "overseer" && run.entityId === scenarioEntityId),
    overseerCommandTrailVisible:
      faultMode === "source-mutation" || finalSnapshot.recentEvents.some((event) => event.type === "overseer.commands_completed"),
    workerRunCompleted: faultMode === "source-mutation" || workerRun?.status === "completed",
    reviewerRunCompleted: faultMode === "source-mutation" || reviewerRun?.status === "completed",
    reviewerEvidenceRecorded: faultMode === "source-mutation" || Boolean(reviewEvidence),
    deterministicCommandEvidenceRecorded: faultMode === "source-mutation" || Boolean(commandEvidence),
    deterministicVerifyAfterReview: faultMode === "source-mutation" || (verifyRuns.length > 0 && Boolean(reviewEvidence)),
    finalOutcomeIsBounded: ["accepted", "blocked", "human_required"].includes(finalOutcome),
    sourceSpecsUnchanged: faultMode === "source-mutation" || finalSourceMutations.every((item) => !item.mutated),
    sourceMutationEscalated:
      faultMode !== "source-mutation" ||
      finalSnapshot.activeEscalations.some(
        (item) =>
          item.entityType === "harness" &&
          item.entityId === scenarioEntityId &&
          item.level === "human_required" &&
          item.message.includes("Immutable source mutation"),
      ),
    acceptedHasCompletedLeases:
      finalOutcome !== "accepted" || Boolean(finalSlice?.leases.every((lease) => lease.status === "completed")),
    blockedHasVisibleReason:
      finalOutcome === "accepted" ||
      finalSnapshot.activeEscalations.some((item) => ["blocker", "human_required", "critical"].includes(item.level)),
  },
  artifacts: artifactPaths,
};

fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

const artifactIndex = buildArtifactIndex(summary);
fs.writeFileSync(artifactIndexPath, `${JSON.stringify(artifactIndex, null, 2)}\n`, "utf8");
fs.writeFileSync(artifactIndexMarkdownPath, renderArtifactIndexMarkdown(artifactIndex), "utf8");
summary.artifactIndex = {
  path: artifactIndexPath,
  markdownPath: artifactIndexMarkdownPath,
  itemCount: artifactIndex.items.length,
  missingExpected: artifactIndex.items.filter((item) => item.expected && !item.exists).map((item) => item.key),
};
summary.assertions.artifactIndexWritten = fs.existsSync(artifactIndexPath) && fs.existsSync(artifactIndexMarkdownPath);
summary.assertions.artifactIndexClassifiesOutcome = artifactIndex.classification.code === outcomeClassification.code;
summary.assertions.artifactIndexLinksCoreEvidence =
  ["summary", "snapshot", "graph", "report", "timeline"].every((key) =>
    artifactIndex.items.some((item) => item.key === key && item.exists),
  ) &&
  (finalOutcome !== "accepted" ||
    ["workerResult", "reviewerResult", "verificationOutput"].every((key) =>
      artifactIndex.items.some((item) => item.key === key && item.exists),
    ));
if (historyEnabled) {
  archiveRunHistory(summary, artifactIndex);
}
summary.assertions.runHistoryArchived =
  !historyEnabled ||
  Boolean(
    historyPaths &&
      fs.existsSync(historyPaths.summary) &&
      fs.existsSync(historyPaths.artifactIndex) &&
      fs.existsSync(historyPaths.artifactIndexMarkdown) &&
      fs.existsSync(historyPaths.runsIndex),
  );

updateManifest({
  phase: runPhase,
  runMode: "live-agent-smoke",
  liveRun: {
    runId,
    command: "npm run demo:live-agent:run",
    driver,
    summary: summaryPath,
    fault: faultMode,
    finalOutcome,
    finalReason,
    outcomeClassification,
    artifactIndex: artifactIndexPath,
    history: summary.history,
    updatedAt: new Date().toISOString(),
  },
});
fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
if (historyEnabled) {
  archiveRunHistory(summary, artifactIndex);
}
console.log(JSON.stringify(summary, null, 2));

function classifyOutcome({
  finalOutcome,
  finalReason,
  faultMode,
  finalSnapshot,
  finalSlice,
  verifyRuns,
  turns,
  staleRecovery,
  finalSourceMutations,
}) {
  const activeBlockingEscalations = finalSnapshot.activeEscalations.filter((item) =>
    ["blocker", "human_required", "critical"].includes(item.level),
  );
  const latestVerify = verifyRuns.at(-1);
  const noProgressTurn = turns
    .filter((turn) => turn.kind === "overseer")
    .find((turn) => {
      const summary = turn.commandSummary;
      return summary && summary.executed === 0 && (summary.blocked > 0 || summary.failed > 0);
    });
  const evidence = {
    sliceId: finalSlice?.id,
    sliceStatus: finalSlice?.status,
    activeBlockingEscalations: activeBlockingEscalations.map((item) => ({
      id: item.id,
      level: item.level,
      entityType: item.entityType,
      entityId: item.entityId,
      message: item.message,
    })),
  };

  if (finalSourceMutations.some((item) => item.mutated)) {
    return {
      code: "source_mutation",
      severity: "human_required",
      explanation: "A registered immutable source spec changed during the run, so the harness stopped affected work.",
      evidence: {
        ...evidence,
        mutatedSources: finalSourceMutations.filter((item) => item.mutated),
      },
    };
  }

  if (finalOutcome === "accepted") {
    return {
      code: "accepted",
      severity: "accepted",
      explanation: "The selected slice reached accepted status after worker evidence, independent review, and deterministic verification.",
      evidence: {
        ...evidence,
        acceptedVerifyRun: latestVerify?.accepted ? latestVerify : undefined,
        reviewStatus: finalSlice?.reviewResult?.status,
      },
    };
  }

  if (/Max (runtime|turns|slices|agent runs)/i.test(finalReason ?? "")) {
    return {
      code: "limit_exceeded",
      severity: "blocked",
      explanation: "The run stopped because one of the configured scenario bounds was reached.",
      evidence: {
        ...evidence,
        finalReason,
      },
    };
  }

  if (faultMode === "stale-run" && staleRecovery.injectedAtTurn && !staleRecovery.restartedAtTurn) {
    return {
      code: "recovery_blocked",
      severity: "blocked",
      explanation: "A stale worker run was detected but recovery did not complete before the run stopped.",
      evidence: {
        ...evidence,
        staleRecovery,
      },
    };
  }

  if (latestVerify && !latestVerify.accepted) {
    return {
      code: "verification_failed",
      severity: finalOutcome === "human_required" ? "human_required" : "blocked",
      explanation: "Deterministic verification ran but did not accept the slice.",
      evidence: {
        ...evidence,
        latestVerify,
      },
    };
  }

  if (hasHumanRequired(finalSnapshot)) {
    return {
      code: "human_required",
      severity: "human_required",
      explanation: "A human-required or critical escalation is active.",
      evidence,
    };
  }

  if (noProgressTurn) {
    return {
      code: "orchestration_no_progress",
      severity: "blocked",
      explanation: "An overseer execution turn completed without executing any useful command and reported blocked or failed commands.",
      evidence: {
        ...evidence,
        turn: noProgressTurn.turn,
        commandSummary: noProgressTurn.commandSummary,
      },
    };
  }

  if (activeBlockingEscalations.length > 0) {
    return {
      code: "blocked_escalation",
      severity: "blocked",
      explanation: "One or more blocker-level escalations remain active.",
      evidence,
    };
  }

  return {
    code: "blocked_unknown",
    severity: finalOutcome === "human_required" ? "human_required" : "blocked",
    explanation: "The run stopped without acceptance, but no more specific classifier matched the final state.",
    evidence: {
      ...evidence,
      finalReason,
    },
  };
}

function buildArtifactIndex(summary) {
  const itemsByPath = new Map();
  const addArtifact = ({ key, category, artifactPath, description, expected = true }) => {
    if (!artifactPath || ["artifactIndex", "artifactIndexMarkdown"].includes(key)) return;
    const resolvedPath = path.resolve(artifactPath);
    if (itemsByPath.has(resolvedPath)) return;
    itemsByPath.set(resolvedPath, {
      key,
      category,
      path: resolvedPath,
      exists: fs.existsSync(resolvedPath),
      expected,
      description,
    });
  };

  for (const [key, artifactPath] of Object.entries(summary.artifacts)) {
    addArtifact({
      key,
      category: artifactCategory(key),
      artifactPath,
      description: artifactDescription(key),
      expected: isExpectedArtifact(key, summary),
    });
  }

  for (const turn of summary.turns) {
    const pathFields = [
      "outputPath",
      "decisionPath",
      "scanOutputPath",
      "markOutputPath",
      "restartOutputPath",
      "warningPath",
    ];
    for (const field of pathFields) {
      addArtifact({
        key: `turn-${turn.turn}-${turn.kind}-${field}`,
        category: "turn",
        artifactPath: turn[field],
        description: `Turn ${turn.turn} ${turn.kind} ${field}.`,
        expected: true,
      });
    }
  }

  const items = [...itemsByPath.values()].sort((left, right) =>
    `${left.category}:${left.key}`.localeCompare(`${right.category}:${right.key}`),
  );
  return {
    generatedAt: new Date().toISOString(),
    workspace: summary.workspace,
    runMode: summary.runMode,
    phase: summary.phase,
    scenario: summary.scenario,
    fault: summary.fault,
    finalOutcome: summary.finalOutcome,
    finalReason: summary.finalReason,
    classification: summary.outcomeClassification,
    counts: {
      items: items.length,
      missingExpected: items.filter((item) => item.expected && !item.exists).length,
      byCategory: items.reduce((accumulator, item) => {
        accumulator[item.category] = (accumulator[item.category] ?? 0) + 1;
        return accumulator;
      }, {}),
    },
    quickOpen: {
      summary: summary.artifacts.summary,
      snapshot: summary.artifacts.snapshot,
      report: summary.artifacts.report,
      timeline: summary.artifacts.timeline,
      latestWorkerResult: summary.artifacts.workerResult,
      latestReviewerResult: summary.artifacts.reviewerResult,
      latestVerificationOutput: summary.artifacts.verificationOutput,
    },
    items,
  };
}

function renderArtifactIndexMarkdown(index) {
  const lines = [
    "# Live Agent Smoke Artifact Index",
    "",
    `Generated: ${index.generatedAt}`,
    `Workspace: ${index.workspace}`,
    `Scenario: ${index.scenario}`,
    `Phase: ${index.phase}`,
    `Fault: ${index.fault.mode}`,
    `Outcome: ${index.finalOutcome}`,
    `Classification: ${index.classification.code} (${index.classification.severity})`,
    "",
    "## Classification",
    "",
    index.classification.explanation,
    "",
    "## Quick Open",
    "",
    ...Object.entries(index.quickOpen)
      .filter(([, value]) => value)
      .map(([key, value]) => `- ${key}: ${value}`),
    "",
    "## Artifacts",
    "",
    "| Category | Key | Exists | Path |",
    "| --- | --- | --- | --- |",
  ];
  for (const item of index.items) {
    lines.push(
      `| ${escapeMarkdownTableCell(item.category)} | ${escapeMarkdownTableCell(item.key)} | ${
        item.exists ? "yes" : "no"
      } | ${escapeMarkdownTableCell(item.path)} |`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function artifactCategory(key) {
  if (["summary", "snapshot", "graph", "report", "timeline"].includes(key)) return "run";
  if (key.includes("worker") || key.includes("reviewer")) return "agent";
  if (key.includes("verification")) return "verification";
  if (key.includes("recovery")) return "recovery";
  if (key.includes("context")) return "handoff";
  if (key.includes("lowSignal")) return "warning";
  return "other";
}

function artifactDescription(key) {
  const descriptions = {
    summary: "Final machine-readable run summary.",
    snapshot: "Final observe snapshot with lanes, slices, agents, events, checkpoints, and escalations.",
    graph: "Final dependency and activity graph.",
    report: "Selected slice report with FR/AC evidence.",
    timeline: "Selected slice timeline.",
    workerEvents: "Latest worker JSONL event stream.",
    workerResult: "Latest structured worker result.",
    reviewerEvents: "Latest reviewer JSONL event stream.",
    reviewerResult: "Latest structured independent review result.",
    verificationOutput: "Latest deterministic verification command output.",
    recoveryScan: "Recovery scan output.",
    recoveryMark: "Recovery mark-stale output.",
    recoveryRestart: "Recovery restart output.",
    contextWorkerPacket: "Worker resume packet generated at context handoff.",
    contextReviewerPacket: "Reviewer resume packet generated at context handoff.",
    contextVerifierPacket: "Verifier resume packet generated at context handoff.",
    contextOverseerPacket: "Overseer resume packet generated at context handoff.",
    contextRecoveryPacket: "Recovery resume packet generated at context handoff.",
    lowSignalWarning: "Lane-scoped low-signal/proof-churn warning artifact.",
  };
  return descriptions[key] ?? "Run artifact.";
}

function isExpectedArtifact(key, summary) {
  if (["summary", "snapshot", "graph", "report", "timeline"].includes(key)) return true;
  if (summary.fault.mode === "source-mutation") return false;
  if (["workerResult", "reviewerResult", "verificationOutput"].includes(key)) return summary.finalOutcome === "accepted";
  return Boolean(summary.artifacts[key]);
}

function escapeMarkdownTableCell(value) {
  return String(value ?? "").replaceAll("|", "\\|");
}

function buildHistoryPaths(runId) {
  const runDir = path.join(historyRoot, runId);
  return {
    root: historyRoot,
    runDir,
    runsIndex: path.join(historyRoot, "runs.json"),
    summary: path.join(runDir, "summary.json"),
    artifactIndex: path.join(runDir, "artifact-index.json"),
    artifactIndexMarkdown: path.join(runDir, "artifact-index.md"),
    originalSummary: summaryPath,
    originalArtifactIndex: artifactIndexPath,
    originalArtifactIndexMarkdown: artifactIndexMarkdownPath,
  };
}

function archiveRunHistory(summary, artifactIndex) {
  const paths = summary.history?.enabled ? summary.history : undefined;
  if (!paths) return;
  fs.mkdirSync(paths.runDir, { recursive: true });
  fs.writeFileSync(paths.summary, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  fs.writeFileSync(paths.artifactIndex, `${JSON.stringify(artifactIndex, null, 2)}\n`, "utf8");
  fs.writeFileSync(paths.artifactIndexMarkdown, renderArtifactIndexMarkdown(artifactIndex), "utf8");

  const index = fs.existsSync(paths.runsIndex)
    ? JSON.parse(fs.readFileSync(paths.runsIndex, "utf8"))
    : { version: 1, root: historyRoot, generatedAt: new Date().toISOString(), runs: [] };
  const record = createHistoryRecord(summary);
  const withoutCurrent = (index.runs ?? []).filter((item) => item.runId !== summary.runId);
  const runs = [...withoutCurrent, record].sort((left, right) =>
    String(left.generatedAt ?? "").localeCompare(String(right.generatedAt ?? "")),
  );
  fs.mkdirSync(historyRoot, { recursive: true });
  fs.writeFileSync(
    paths.runsIndex,
    `${JSON.stringify(
      {
        version: 1,
        root: historyRoot,
        generatedAt: index.generatedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        runs,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function createHistoryRecord(summary) {
  return {
    runId: summary.runId,
    scenario: summary.scenario,
    runMode: summary.runMode,
    phase: summary.phase,
    driver: summary.driver,
    faultMode: summary.fault.mode,
    startedAt: summary.startedAt,
    generatedAt: summary.generatedAt,
    finalOutcome: summary.finalOutcome,
    finalReason: summary.finalReason,
    classificationCode: summary.outcomeClassification.code,
    classificationSeverity: summary.outcomeClassification.severity,
    sliceId: summary.sliceId,
    finalSliceStatus: summary.finalSliceStatus,
    counts: pickComparableCounts(summary.counts),
    workspace: summary.workspace,
    summary: summary.history.summary,
    artifactIndex: summary.history.artifactIndex,
    artifactIndexMarkdown: summary.history.artifactIndexMarkdown,
    originalSummary: summary.history.originalSummary,
    originalArtifactIndex: summary.history.originalArtifactIndex,
    originalArtifactIndexMarkdown: summary.history.originalArtifactIndexMarkdown,
  };
}

function pickComparableCounts(counts = {}) {
  return {
    turns: counts.turns ?? 0,
    verifyRuns: counts.verifyRuns ?? 0,
    lanes: counts.lanes ?? 0,
    slices: counts.slices ?? 0,
    agentRuns: counts.agentRuns ?? 0,
    evidence: counts.evidence ?? 0,
    activeEscalations: counts.activeEscalations ?? 0,
    graphNodes: counts.graphNodes ?? 0,
    graphEdges: counts.graphEdges ?? 0,
    timelineItems: counts.timelineItems ?? 0,
  };
}

function compactTimestamp(value) {
  return value.replace(/[^0-9A-Za-z]/g, "").slice(0, 15);
}

function sanitizeRunId(value) {
  const normalized = String(value ?? "").trim().replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-");
  if (!normalized || normalized === "." || normalized === "..") {
    throw new Error("Invalid --run-id; expected at least one alphanumeric, dot, underscore, or hyphen.");
  }
  return normalized.slice(0, 120);
}

function resetScenario() {
  if (samePath(workspace, defaultWorkspace)) {
    execFileSync(process.execPath, [resetScript], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    return;
  }

  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(invoiceTemplate, invoiceTarget, { recursive: true });
  fs.cpSync(dashboardTemplate, dashboardTarget, { recursive: true });
  fs.mkdirSync(path.dirname(productSpec), { recursive: true });
  fs.copyFileSync(sourceProductSpec, productSpec);
  runSwarm(["init"]);
  runSwarm(["run-mode", "set", "live-agent-smoke"]);
  runSwarm(["target", "init", invoiceTarget]);
  runSwarm(["target", "init", dashboardTarget]);
  runSwarm([
    "sources",
    "add-file",
    productSpec,
    "--domain",
    "Invoice Product",
    "--tags",
    "product,full-stack,invoice-dashboard",
    "--priority",
    "1",
  ]);
  runSwarm([
    "sources",
    "add-file",
    invoiceSpec,
    "--domain",
    "Invoice Backend",
    "--tags",
    "backend,api,invoices,dashboard-enabler",
    "--priority",
    "2",
  ]);
  runSwarm([
    "sources",
    "add-file",
    dashboardSpec,
    "--domain",
    "Invoice Dashboard",
    "--tags",
    "frontend,dashboard,invoices",
    "--priority",
    "3",
  ]);
  const snapshot = observe(40);
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        scenarioId: scenario,
        runMode: "live-agent-smoke",
        phase: "phase-1-reset-and-run-mode",
        generatedAt: new Date().toISOString(),
        workspace,
        productSpec,
        expectedOutcome: "accepted_product_or_blocked_with_reasons",
        targets: [
          { name: "invoice-api", path: invoiceTarget, role: "backend", source: invoiceSpec },
          { name: "invoice-dashboard", path: dashboardTarget, role: "frontend", source: dashboardSpec },
        ],
        sources: snapshot.sources.map((source) => ({
          id: source.id,
          title: source.title,
          uri: source.uri,
          hash: source.hash,
          domain: source.metadata?.domain ?? "Unassigned",
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function ensureWorkspaceInitialized() {
  if (!fs.existsSync(path.join(workspace, ".swarm", "state.db"))) {
    throw new Error(`Live smoke workspace is not initialized: ${workspace}. Run npm run demo:live-agent:reset first.`);
  }
}

function updateManifest(patch) {
  if (!fs.existsSync(manifestPath)) return;
  const current = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  fs.writeFileSync(manifestPath, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`, "utf8");
}

function injectConfiguredFault() {
  if (faultMode === "none") return [];
  if (faultMode === "source-mutation") {
    const mutation = `\n\n<!-- injected live smoke source mutation fault ${new Date().toISOString()} -->\n`;
    fs.appendFileSync(productSpec, mutation, "utf8");
    return [
      {
        mode: faultMode,
        path: productSpec,
        expectedDetection: "registered source hash mismatch",
      },
    ];
  }
  if (faultMode === "reviewer-repair") {
    return [
      {
        mode: faultMode,
        expectedDetection: "reviewer returns repair_required before accepting the repaired slice",
      },
    ];
  }
  if (faultMode === "stale-run") {
    return [
      {
        mode: faultMode,
        expectedDetection: "recovery scan marks a stale worker run and restart completes before verification",
      },
    ];
  }
  if (faultMode === "context-handoff") {
    return [
      {
        mode: faultMode,
        expectedDetection: "resume packets and latest checkpoints allow fresh roles to continue from durable harness state",
      },
    ];
  }
  if (faultMode === "low-signal") {
    return [
      {
        mode: faultMode,
        expectedDetection: "planner low-signal warning remains visible while review and verification still gate acceptance",
      },
    ];
  }
  return [];
}

function observe(events) {
  return JSON.parse(runSwarm(["observe", "--events", String(events)]));
}

function runSwarm(commandArgs) {
  return execFileSync(process.execPath, [cli, ...commandArgs], {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SWARM_LIVE_FAULT: faultMode },
  });
}

function handleStaleRunFault(turn, snapshot) {
  if (faultMode !== "stale-run" || staleRecovery.restartedAtTurn) return undefined;
  const slice =
    (staleRecovery.sliceId ? snapshot.slices.find((item) => item.id === staleRecovery.sliceId) : undefined) ??
    snapshot.slices.find((item) => ["ready", "blocked", "repairing", "implemented"].includes(item.status));
  if (!slice) return undefined;

  if (!staleRecovery.injectedAtTurn) {
    injectStaleAgentRun(slice.id, turn);
  }

  const scanOutput = runSwarm(["recovery", "scan", "--stale-after", "60"]);
  staleRecovery.scanOutputPath = path.join(artifactsPath, `turn-${turn}-recovery-scan.txt`);
  fs.writeFileSync(staleRecovery.scanOutputPath, scanOutput, "utf8");

  const markOutput = runSwarm(["recovery", "scan", "--stale-after", "60", "--mark-stale"]);
  staleRecovery.markOutputPath = path.join(artifactsPath, `turn-${turn}-recovery-mark-stale.txt`);
  fs.writeFileSync(staleRecovery.markOutputPath, markOutput, "utf8");
  staleRecovery.markedAtTurn = turn;

  const restartOutput = runSwarm([
    "recovery",
    "restart",
    staleRecovery.staleRunId,
    "--actor",
    staleRecovery.restartActor,
    "--driver",
    driver,
  ]);
  staleRecovery.restartOutputPath = path.join(artifactsPath, `turn-${turn}-recovery-restart.txt`);
  fs.writeFileSync(staleRecovery.restartOutputPath, restartOutput, "utf8");
  staleRecovery.restartedAtTurn = turn;

  const after = observe(220);
  const recoveredSlice = after.slices.find((item) => item.id === slice.id);
  const staleRunAfter = after.agentRuns.find((run) => run.id === staleRecovery.staleRunId);
  const restartedRun = after.agentRuns.find(
    (run) =>
      run.sliceId === slice.id &&
      run.id !== staleRecovery.staleRunId &&
      run.role === "worker" &&
      run.status === "completed",
  );
  return {
    turn,
    kind: "recovery",
    sliceId: slice.id,
    staleRunId: staleRecovery.staleRunId,
    scanOutputPath: staleRecovery.scanOutputPath,
    markOutputPath: staleRecovery.markOutputPath,
    restartOutputPath: staleRecovery.restartOutputPath,
    staleRunStatusAfter: staleRunAfter?.status,
    restartedRunId: restartedRun?.id,
    restartedRunStatus: restartedRun?.status,
    sliceStatusAfter: recoveredSlice?.status,
  };
}

function handleContextHandoffFault(turn, snapshot) {
  if (faultMode !== "context-handoff" || contextHandoff.generatedAtTurn) return undefined;
  const slice = snapshot.slices.find(
    (item) =>
      item.status === "implemented" &&
      item.evidence.some((evidence) => evidence.kind === "worker_result") &&
      !item.evidence.some((evidence) => evidence.kind === "review_result"),
  );
  if (!slice) return undefined;

  const workerRun = snapshot.agentRuns
    .filter((run) => run.sliceId === slice.id && run.role === "worker" && run.status === "completed")
    .at(-1);
  if (!workerRun) return undefined;

  contextHandoff.sliceId = slice.id;
  contextHandoff.laneId = slice.laneId;
  contextHandoff.workerRunId = workerRun.id;
  contextHandoff.generatedAtTurn = turn;

  const checkpointSpecs = [
    { key: "worker", role: "worker", entity: `slice:${slice.id}` },
    { key: "reviewer", role: "reviewer", entity: `slice:${slice.id}` },
    { key: "verifier", role: "verifier", entity: `slice:${slice.id}` },
    { key: "overseer", role: "overseer", entity: `lane:${slice.laneId}` },
  ];
  for (const spec of checkpointSpecs) {
    const output = runSwarm([
      "checkpoint",
      "create",
      "--entity",
      spec.entity,
      "--role",
      spec.role,
      "--actor",
      "live-context-handoff",
    ]);
    const outputPath = path.join(artifactsPath, `turn-${turn}-checkpoint-${spec.key}.txt`);
    fs.writeFileSync(outputPath, output, "utf8");
    contextHandoff.checkpointOutputPaths[spec.key] = outputPath;
    contextHandoff.checkpointIds[spec.key] = parseCheckpointId(output);
  }

  const packetSpecs = [
    { key: "worker", args: ["resume-context", "--entity", `slice:${slice.id}`, "--role", "worker"] },
    { key: "reviewer", args: ["resume-context", "--entity", `slice:${slice.id}`, "--role", "reviewer"] },
    { key: "verifier", args: ["resume-context", "--entity", `slice:${slice.id}`, "--role", "verifier"] },
    { key: "overseer", args: ["resume-context", "--entity", `lane:${slice.laneId}`, "--role", "overseer"] },
    { key: "recovery", args: ["resume-context", "--run", workerRun.id] },
  ];
  for (const spec of packetSpecs) {
    const output = runSwarm(spec.args);
    const outputPath = path.join(artifactsPath, `turn-${turn}-resume-${spec.key}.md`);
    fs.writeFileSync(outputPath, output, "utf8");
    contextHandoff.packetPaths[spec.key] = outputPath;
  }

  const after = observe(220);
  return {
    turn,
    kind: "context-handoff",
    sliceId: slice.id,
    laneId: slice.laneId,
    workerRunId: workerRun.id,
    checkpointIds: contextHandoff.checkpointIds,
    packetPaths: contextHandoff.packetPaths,
    checkpointCountAfter: after.checkpoints.length,
    eventTypesAfter: after.recentEvents.slice(-8).map((event) => event.type),
  };
}

function handleLowSignalFault(turn, snapshot) {
  if (faultMode !== "low-signal" || lowSignal.injectedAtTurn) return undefined;
  const slice = snapshot.slices.find(
    (item) =>
      item.status === "implemented" &&
      item.evidence.some((evidence) => evidence.kind === "worker_result") &&
      !item.evidence.some((evidence) => evidence.kind === "review_result"),
  );
  if (!slice) return undefined;

  const warning = insertLowSignalWarning(slice, turn);
  return {
    turn,
    kind: "low-signal-warning",
    sliceId: slice.id,
    laneId: slice.laneId,
    escalationId: warning.escalationId,
    checkpointId: warning.checkpointId,
    warningPath: warning.warningPath,
    message: warning.message,
  };
}

function insertLowSignalWarning(slice, turn) {
  const now = new Date().toISOString();
  const message =
    "Low-signal slice cadence detected: proof-churn sentinel saw work that could pass mechanically without a visible downstream decision.";
  const reason =
    "The live smoke injected this warning to prove proof-churn concerns stay visible without bypassing reviewer and deterministic verification gates.";
  const escalation = {
    id: makeId("escalation"),
    level: "warning",
    status: "active",
    entityType: "lane",
    entityId: slice.laneId,
    message,
    reason,
    createdBy: "live-proof-churn-sentinel",
    createdAt: now,
    updatedAt: now,
  };
  const store = new SwarmStore(workspace);
  try {
    store.insertEscalation(escalation);
    store.addEvent(
      createEvent({
        actor: "live-proof-churn-sentinel",
        type: "planner.low_signal_work",
        entityType: "lane",
        entityId: slice.laneId,
        payload: {
          faultMode: "low-signal",
          escalationId: escalation.id,
          level: escalation.level,
          sliceIds: [slice.id],
          threshold: 1,
          reason,
          suggestedAction:
            "Keep the warning visible, require independent review and deterministic verification, then decide whether a larger readiness pack is needed.",
        },
      }),
    );
    const checkpoint = refreshCheckpoint({
      store,
      role: "planner",
      entityType: "lane",
      entityId: slice.laneId,
      actor: "live-proof-churn-sentinel",
      reason: "Injected low-signal/proof-churn warning for live smoke.",
    });
    lowSignal.sliceId = slice.id;
    lowSignal.laneId = slice.laneId;
    lowSignal.injectedAtTurn = turn;
    lowSignal.escalationId = escalation.id;
    lowSignal.checkpointId = checkpoint.id;
  } finally {
    store.close();
  }

  lowSignal.warningPath = path.join(artifactsPath, `turn-${turn}-low-signal-warning.json`);
  fs.writeFileSync(
    lowSignal.warningPath,
    `${JSON.stringify(
      {
        mode: "low-signal",
        injectedAtTurn: turn,
        sliceId: slice.id,
        laneId: slice.laneId,
        escalationId: escalation.id,
        checkpointId: lowSignal.checkpointId,
        message,
        reason,
        expectedContinuation: "Independent review and deterministic verification must still pass before acceptance.",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { escalationId: escalation.id, checkpointId: lowSignal.checkpointId, warningPath: lowSignal.warningPath, message };
}

function injectStaleAgentRun(sliceId, turn) {
  const staleTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const store = new SwarmStore(workspace);
  try {
    store.insertAgentRun({
      id: staleRecovery.staleRunId,
      sliceId,
      role: "worker",
      entityType: "slice",
      entityId: sliceId,
      actor: "live-stale-worker",
      driver,
      status: "running",
      attempt: 1,
      startedAt: staleTimestamp,
      updatedAt: staleTimestamp,
    });
    store.upsertHeartbeat({
      id: "heartbeat:live-stale-worker",
      actor: "live-stale-worker",
      state: "thinking",
      detail: "Injected stale worker run for live smoke recovery fault",
      entityType: "slice",
      entityId: sliceId,
      timestamp: staleTimestamp,
    });
  } finally {
    store.close();
  }
  staleRecovery.sliceId = sliceId;
  staleRecovery.injectedAtTurn = turn;
}

function contextHandoffPacketAssertions() {
  if (faultMode !== "context-handoff") return {};
  return {
    worker: packetIncludes("worker", ["Resume Packet: worker slice:", "Worker Focus", "FR/AC Scope", "Guardrails"]),
    reviewer: packetIncludes("reviewer", ["Resume Packet: reviewer slice:", "Reviewer / Sleuth Focus", "Worker claims"]),
    verifier: packetIncludes("verifier", ["Resume Packet: verifier slice:", "Verifier Focus", "Block acceptance unless every in-scope FR/AC"]),
    overseer: packetIncludes("overseer", ["Resume Packet: overseer lane:", "Planner / Overseer Focus", "Active slices"]),
    recovery: packetIncludes("recovery", ["Resume Packet: recovery agent_run:", "Recovery Focus", "Artifact paths"]),
  };
}

function packetIncludes(key, expected) {
  const packetPath = contextHandoff.packetPaths[key];
  if (!packetPath || !fs.existsSync(packetPath)) return false;
  const content = fs.readFileSync(packetPath, "utf8");
  return expected.every((text) => content.includes(text));
}

function clearResolvedRepairEscalations(sliceId, activeEscalations, turn) {
  const clearable = activeEscalations.filter((escalation) => {
    if (escalation.entityType !== "slice" || escalation.entityId !== sliceId) return false;
    if (escalation.level !== "blocker") return false;
    const haystack = `${escalation.message ?? ""} ${escalation.reason ?? ""} ${escalation.createdBy ?? ""}`.toLowerCase();
    return haystack.includes("review") || haystack.includes("repair");
  });
  const cleared = [];
  for (const escalation of clearable) {
    runSwarm([
      "escalations",
      "clear",
      escalation.id,
      "--reason",
      "Latest independent review accepted the repaired slice.",
      "--actor",
      "live-acceptance-loop",
    ]);
    cleared.push({
      turn,
      sliceId,
      escalationId: escalation.id,
      message: escalation.message,
    });
  }
  return cleared;
}

function parseCheckpointId(output) {
  const match = /Refreshed checkpoint (CHK-[a-f0-9]+)/i.exec(output);
  return match?.[1];
}

function clearResolvedStaleRecoveryEscalations(sliceId, activeEscalations, turn) {
  if (faultMode !== "stale-run" || staleRecovery.sliceId !== sliceId || !staleRecovery.restartedAtTurn) return [];
  const clearable = activeEscalations.filter((escalation) => {
    if (escalation.entityType !== "slice" || escalation.entityId !== sliceId) return false;
    if (escalation.level !== "blocker") return false;
    return escalation.message.includes(staleRecovery.staleRunId);
  });
  const cleared = [];
  for (const escalation of clearable) {
    runSwarm([
      "escalations",
      "clear",
      escalation.id,
      "--reason",
      "Fresh restarted worker completed and independent review accepted the recovered slice.",
      "--actor",
      "live-acceptance-loop",
    ]);
    cleared.push({
      turn,
      sliceId,
      escalationId: escalation.id,
      staleRunId: staleRecovery.staleRunId,
      message: escalation.message,
    });
  }
  return cleared;
}

function isReadyForDeterministicVerify(slice) {
  if (slice.status !== "ready_for_review") return false;
  if (slice.reviewResult?.status !== "accepted") return false;
  return !slice.evidence.some((item) => item.kind === "command" && item.payload?.passed === true);
}

function inspectSourceMutations(sources) {
  return sources.map((source) => {
    if (!source.hash) {
      return {
        id: source.id,
        title: source.title,
        uri: source.uri,
        mutated: false,
        reason: "No registered source hash was available.",
      };
    }
    if (!fs.existsSync(source.uri)) {
      return {
        id: source.id,
        title: source.title,
        uri: source.uri,
        expectedHash: source.hash,
        mutated: true,
        reason: "Source file is missing.",
      };
    }
    const currentHash = createHash("sha256").update(fs.readFileSync(source.uri)).digest("hex");
    return {
      id: source.id,
      title: source.title,
      uri: source.uri,
      expectedHash: source.hash,
      currentHash,
      mutated: currentHash !== source.hash,
      reason: currentHash === source.hash ? undefined : "Source hash differs from registered immutable hash.",
    };
  });
}

function raiseScenarioEscalation(level, message) {
  try {
    runSwarm([
      "escalations",
      "create",
      "--level",
      level,
      "--entity-type",
      "harness",
      "--entity-id",
      scenarioEntityId,
      "--message",
      message,
      "--actor",
      "live-acceptance-loop",
    ]);
  } catch {
    // The summary still records the failure if escalation creation itself fails.
  }
}

function hasHumanRequired(snapshot) {
  return snapshot.activeEscalations.some((item) => item.level === "human_required" || item.level === "critical");
}

function assertApprovedWorkspace(target) {
  const demoRoot = path.join(repoRoot, ".swarm-demo");
  const resolved = path.resolve(target);
  if (!resolved.toLowerCase().startsWith(`${demoRoot.toLowerCase()}${path.sep}`)) {
    throw new Error(`Refusing to run live smoke outside ${demoRoot}: ${resolved}`);
  }
  if (samePath(resolved, repoRoot) || samePath(resolved, path.dirname(repoRoot)) || samePath(resolved, demoRoot)) {
    throw new Error(`Refusing unsafe live smoke workspace: ${resolved}`);
  }
}

function assertApprovedHistoryRoot(target, currentWorkspace) {
  const demoRoot = path.join(repoRoot, ".swarm-demo");
  const resolved = path.resolve(target);
  const resolvedLower = resolved.toLowerCase();
  const workspaceLower = path.resolve(currentWorkspace).toLowerCase();
  if (!resolvedLower.startsWith(`${demoRoot.toLowerCase()}${path.sep}`)) {
    throw new Error(`Refusing to write live smoke history outside ${demoRoot}: ${resolved}`);
  }
  if (samePath(resolved, repoRoot) || samePath(resolved, path.dirname(repoRoot)) || samePath(resolved, demoRoot)) {
    throw new Error(`Refusing unsafe live smoke history root: ${resolved}`);
  }
  if (samePath(resolved, currentWorkspace) || resolvedLower.startsWith(`${workspaceLower}${path.sep}`)) {
    throw new Error(`Refusing to write live smoke history inside reset workspace: ${resolved}`);
  }
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = "true";
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}
