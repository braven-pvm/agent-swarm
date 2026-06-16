#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { refreshCheckpoint } from "../dist/checkpoints.js";
import { createEvent } from "../dist/events.js";
import { makeId } from "../dist/ids.js";
import { buildCoverage } from "../dist/observability.js";
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
const mode = args.mode ?? "acceptance-loop";
if (!["acceptance-loop", "full-product"].includes(mode)) {
  throw new Error(`Invalid --mode ${mode}; expected acceptance-loop or full-product`);
}
const fullProductMode = mode === "full-product";
const maxTurns = Number.parseInt(args["max-turns"] ?? (fullProductMode ? "40" : "8"), 10);
const executeLimit = Number.parseInt(args["execute-limit"] ?? (fullProductMode ? "4" : "3"), 10);
const maxRuntimeSeconds = Number.parseInt(args["max-runtime-seconds"] ?? (fullProductMode ? "2700" : "600"), 10);
const maxSlices = Number.parseInt(args["max-slices"] ?? (fullProductMode ? "12" : "5"), 10);
const maxAgentRuns = Number.parseInt(args["max-agent-runs"] ?? (fullProductMode ? "60" : "12"), 10);
const faultMode = args.fault ?? "none";
const validFaultModes = [
  "none",
  "source-mutation",
  "reviewer-repair",
  "stale-run",
  "context-handoff",
  "low-signal",
  "supervised-revive",
];
if (!validFaultModes.includes(faultMode)) {
  throw new Error(
    `Invalid --fault ${faultMode}; expected ${validFaultModes.slice(0, -1).join(", ")}, or ${validFaultModes.at(-1)}`,
  );
}
if (fullProductMode && faultMode !== "none") {
  throw new Error("Full-product mode does not support fault injection yet; run Phase 6 faults with --mode acceptance-loop.");
}
const runPhase = fullProductMode
  ? "phase-8-full-product-execution"
  : faultMode === "none"
    ? "phase-5c-autonomous-acceptance-loop"
    : "phase-6-fault-injection";
const cli = path.join(repoRoot, "dist", "cli.js");
const resetScript = path.join(repoRoot, "scripts", "reset-live-agent-smoke.mjs");
const sourceProductSpec = path.join(repoRoot, "docs", "requirements", "live-smoke-invoice-dashboard-product-spec.md");

const invoiceTarget = path.join(workspace, "invoice-api");
const dashboardTarget = path.join(workspace, "invoice-dashboard");
const productSpec = path.join(workspace, "source-specs", "live-smoke-invoice-dashboard-product-spec.md");
const invoiceSpec = path.join(invoiceTarget, "specs", "invoice-api.md");
const dashboardSpec = path.join(dashboardTarget, "specs", "invoice-dashboard.md");
const manifestPath = path.join(workspace, "live-agent-smoke.json");
const summaryPath = path.resolve(args.summary ?? path.join(workspace, "live-agent-run-summary.json"));
const artifactsPath = path.resolve(args.artifacts ?? path.join(workspace, "live-agent-run-artifacts"));
const productReadinessPath = path.join(artifactsPath, "product-readiness.json");
const productReadinessMarkdownPath = path.join(artifactsPath, "product-readiness.md");
const productTestOutputPath = path.join(artifactsPath, "product-dashboard-test-output.txt");
const productStartOutputPath = path.join(artifactsPath, "product-dashboard-start-output.txt");
const productProbePath = path.join(artifactsPath, "product-dashboard-probe.json");
const productProbeMarkdownPath = path.join(artifactsPath, "product-dashboard-probe.md");
const historyRoot = path.resolve(args["history-root"] ?? path.join(repoRoot, ".swarm-demo", "live-agent-run-history"));
const historyEnabled = args.history !== "false";
const scenarioEntityId = `scenario:${scenario}`;
const runStartedAt = new Date().toISOString();
const runId = sanitizeRunId(args["run-id"] ?? `LAR-${compactTimestamp(runStartedAt)}-${scenario}-${faultMode}-${process.pid}`);
const SWARM_CLI_MAX_BUFFER = 50 * 1024 * 1024;
const productReadinessRefs = ["AC-PROD-001.1", "AC-PROD-001.2", "AC-PROD-001.3", "AC-PROD-001.4"];
const productReadinessBlockerIds = new Set([
  "dashboard-test-script",
  "dashboard-test-passes",
  "dashboard-start-script",
  "dashboard-start-probed",
]);

assertApprovedWorkspace(workspace);
if (historyEnabled) assertApprovedHistoryRoot(historyRoot, workspace);
if (!fs.existsSync(cli)) throw new Error(`Built CLI not found: ${cli}. Run npm run build first.`);
if (resetBeforeRun || !fs.existsSync(path.join(workspace, ".swarm", "state.db"))) {
  resetScenario();
}
ensureWorkspaceInitialized();
if (fullProductMode) {
  assertFullProductPrerequisites();
}

runSwarm(["run-mode", "set", "live-agent-smoke"]);
updateManifest({
  phase: runPhase,
  runMode: "live-agent-smoke",
  mode,
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
const supervisedRecovery = {
  recoveredRunId: undefined,
  revivedRunId: undefined,
  restartedRunId: undefined,
  sliceId: undefined,
  detectedAtTurn: undefined,
  revivedAtTurn: undefined,
  restartedAtTurn: undefined,
  focusRunOutputPath: undefined,
  focusSliceOutputPath: undefined,
  reviveOutputPath: undefined,
  restartOutputPath: undefined,
  reviveActor: "live-recovery-agent",
  restartActor: "live-recovery-worker",
  attemptedRunIds: [],
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
const dependencyWarningClearances = [];
const diagnosticWarningClearances = [];
const acceptedSliceWarningClearances = [];
let finalOutcome = undefined;
let finalReason = undefined;
let finalSliceId = undefined;
let productReadiness = undefined;

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

  const supervisedAction = handleSupervisedRecovery(turn, before);
  if (supervisedAction) {
    turns.push(supervisedAction);
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

  const activeSlices = before.slices.filter((slice) => isActiveSlice(slice));
  const acceptedSlice = before.slices.find((slice) => slice.status === "accepted");
  if (acceptedSlice && (!fullProductMode || activeSlices.length === 0)) {
    finalSliceId = acceptedSlice.id;
    recordAcceptedSliceWarningClearances(acceptedSlice, before.activeEscalations, turn);
    if (fullProductMode) {
      productReadiness = inspectProductReadiness({ runCommands: true });
      recordDependencyWarningClearances(productReadiness, before, turn);
      if (productReadiness.passed) {
        finalOutcome = "accepted";
        finalReason = "Full-product readiness passed; invoice dashboard target is locally runnable.";
        break;
      }
      turns.push({
        turn,
        kind: "product-readiness",
        sliceId: acceptedSlice.id,
        passed: false,
        blockers: productReadiness.blockers,
      });
      const readinessWork = ensureProductReadinessWork({ productReadiness, snapshot: before, turn });
      if (readinessWork) {
        turns.push(readinessWork);
        continue;
      }
      if (productReadiness.noFurtherWorkVisible) {
        finalOutcome = "blocked";
        finalReason = `Full-product readiness failed with no further visible work: ${productReadiness.blockers
          .map((item) => item.message)
          .join("; ")}`;
        raiseScenarioEscalation("blocker", finalReason);
        break;
      }
    } else {
      finalOutcome = "accepted";
      finalReason = `Slice ${acceptedSlice.id} is accepted.`;
      break;
    }
  } else if (acceptedSlice && fullProductMode && activeSlices.length > 0) {
    turns.push({
      turn,
      kind: "product-readiness-deferred",
      sliceId: acceptedSlice.id,
      activeSlices: activeSlices.map((slice) => ({ id: slice.id, status: slice.status, refs: slice.frAcRefs })),
      reason: "Accepted work exists, but active product work is still visible.",
    });
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
      finalSliceId = readyForVerify.id;
      recordAcceptedSliceWarningClearances(verifiedSlice, afterVerify.activeEscalations, turn);
      if (fullProductMode) {
        productReadiness = inspectProductReadiness({ runCommands: true });
        recordDependencyWarningClearances(productReadiness, afterVerify, turn);
        if (productReadiness.passed) {
          finalOutcome = "accepted";
          finalReason = "Full-product readiness passed; invoice dashboard target is locally runnable.";
          break;
        }
        turns.push({
          turn,
          kind: "product-readiness",
          sliceId: readyForVerify.id,
          passed: false,
          blockers: productReadiness.blockers,
        });
        const readinessWork = ensureProductReadinessWork({ productReadiness, snapshot: afterVerify, turn });
        if (readinessWork) {
          turns.push(readinessWork);
          continue;
        }
        if (productReadiness.noFurtherWorkVisible) {
          finalOutcome = "blocked";
          finalReason = `Full-product readiness failed with no further visible work: ${productReadiness.blockers
            .map((item) => item.message)
            .join("; ")}`;
          raiseScenarioEscalation("blocker", finalReason);
          break;
        } else {
          continue;
        }
      }
      finalOutcome = "accepted";
      finalReason = `Slice ${readyForVerify.id} passed reviewer and deterministic verification gates.`;
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
    if (fullProductMode && commandSummaryHasRecoverableDependencyBlock(latestCommandSummary)) {
      turns.push({
        turn,
        kind: "recoverable-dependency-block",
        reason: "Overseer attempted dependency-blocked downstream work; continuing so the next overseer turn can select prerequisite source work.",
        commandSummary: latestCommandSummary,
      });
      continue;
    }
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

productReadiness = productReadiness ?? inspectProductReadiness({ runCommands: fullProductMode });
if (fullProductMode) {
  recordAllAcceptedSliceWarningClearances(observe(120), "final");
  recordDependencyWarningClearances(productReadiness, observe(120), "final");
}

const finalSnapshot = observe(260);
const finalSourceMutations = inspectSourceMutations(finalSnapshot.sources);
const graph = JSON.parse(runSwarm(["graph", "--format", "json"]));
const acceptedSlice = finalSnapshot.slices.filter((slice) => slice.status === "accepted").at(-1);
const selectedSliceId = finalSliceId ?? acceptedSlice?.id ?? finalSnapshot.slices.at(-1)?.id;
const report = selectedSliceId ? runSwarm(["report", selectedSliceId]) : "";
const timeline = selectedSliceId ? JSON.parse(runSwarm(["timeline", selectedSliceId, "--json"])) : { items: [] };

const snapshotPath = path.join(artifactsPath, "observe.json");
const graphPath = path.join(artifactsPath, "graph.json");
const reportPath = path.join(artifactsPath, "slice-report.md");
const timelinePath = path.join(artifactsPath, "timeline.json");
const artifactIndexPath = path.join(artifactsPath, "artifact-index.json");
const artifactIndexMarkdownPath = path.join(artifactsPath, "artifact-index.md");
const historyPaths = historyEnabled ? buildHistoryPaths(runId) : undefined;
const finalTargetSnapshots = historyPaths ? snapshotFinalTargets(historyPaths) : undefined;
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
const supervisedReviveRun = supervisedRecovery.revivedRunId
  ? finalSnapshot.agentRuns.find((run) => run.id === supervisedRecovery.revivedRunId)
  : undefined;
const supervisedRestartRun = supervisedRecovery.restartedRunId
  ? finalSnapshot.agentRuns.find((run) => run.id === supervisedRecovery.restartedRunId)
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
  fullProductMode,
  productReadiness,
  finalSnapshot,
  finalSlice,
  verifyRuns,
  turns,
  staleRecovery,
  supervisedRecovery,
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
  recoveryRunFocus: supervisedRecovery.focusRunOutputPath,
  recoverySliceFocus: supervisedRecovery.focusSliceOutputPath,
  recoveryRevive: supervisedRecovery.reviveOutputPath,
  recoveryRestartAfterRevive: supervisedRecovery.restartOutputPath,
  contextWorkerPacket: contextHandoff.packetPaths.worker,
  contextReviewerPacket: contextHandoff.packetPaths.reviewer,
  contextVerifierPacket: contextHandoff.packetPaths.verifier,
  contextOverseerPacket: contextHandoff.packetPaths.overseer,
  contextRecoveryPacket: contextHandoff.packetPaths.recovery,
  lowSignalWarning: lowSignal.warningPath,
  productReadiness: fullProductMode ? productReadinessPath : undefined,
  productReadinessMarkdown: fullProductMode ? productReadinessMarkdownPath : undefined,
  productTestOutput: fullProductMode ? productReadiness.commandResults.test.outputPath : undefined,
  productStartOutput: fullProductMode ? productReadiness.commandResults.start.outputPath : undefined,
  productProbe: fullProductMode ? productReadiness.commandResults.start.probeOutputPath : undefined,
  productProbeMarkdown: fullProductMode ? productReadiness.commandResults.start.probeMarkdownPath : undefined,
  finalInvoiceApi: finalTargetSnapshots?.invoiceApi?.path,
  finalInvoiceDashboard: finalTargetSnapshots?.invoiceDashboard?.path,
  artifactIndex: artifactIndexPath,
  artifactIndexMarkdown: artifactIndexMarkdownPath,
};

const finalCoverage = readCoverageSummary();
const finalOutcomeVsCoverage = summarizeOutcomeVsCoverage(finalOutcome, finalCoverage);

const summary = {
  runId,
  workspace,
  driver,
  runMode: finalSnapshot.runMode,
  startedAt: runStartedAt,
  generatedAt: new Date().toISOString(),
  phase: runPhase,
  scenario,
  mode,
  fault: {
    mode: faultMode,
    injected: injectedFaults,
  },
  finalOutcome,
  finalReason,
  outcomeClassification,
  coverage: {
    generatedAt: finalCoverage.generatedAt,
    totals: finalCoverage.totals,
    interpretation: finalCoverage.interpretation,
    byDomain: finalCoverage.byDomain,
  },
  outcomeVsCoverage: finalOutcomeVsCoverage,
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
  dependencyWarningClearances,
  diagnosticWarningClearances,
  acceptedSliceWarningClearances,
  staleRecovery: faultMode === "stale-run" ? staleRecovery : undefined,
  supervisedRecovery:
    faultMode === "supervised-revive" || supervisedRecovery.detectedAtTurn
      ? {
          ...supervisedRecovery,
          revivedRunStatus: supervisedReviveRun?.status,
          restartedRunStatus: supervisedRestartRun?.status,
        }
      : undefined,
  contextHandoff: faultMode === "context-handoff" ? contextHandoff : undefined,
  lowSignal: faultMode === "low-signal" ? lowSignal : undefined,
  productReadiness: fullProductMode ? productReadiness : undefined,
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
        finalTargets: finalTargetSnapshots,
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
      (faultMode === "low-signal" && Boolean(lowSignalWarning) && Boolean(lowSignalEvent)) ||
      (faultMode === "supervised-revive" &&
        Boolean(supervisedRecovery.detectedAtTurn) &&
        finalSnapshot.recentEvents.some((event) => event.type === "worker.child_idle_timeout")),
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
    supervisedReviveLoopExercised:
      faultMode !== "supervised-revive" ||
      Boolean(
        supervisedRecovery.detectedAtTurn &&
          supervisedRecovery.revivedAtTurn &&
          supervisedReviveRun?.status === "completed" &&
          finalSnapshot.recentEvents.some((event) => event.type === "recovery.revive_started") &&
          finalSnapshot.recentEvents.some((event) => event.type === "recovery.revive_completed"),
      ),
    supervisedRecoveryDoesNotBypassVerification:
      faultMode !== "supervised-revive" ||
      Boolean(verifyRuns.some((run) => run.turn > supervisedRecovery.detectedAtTurn && run.accepted) && finalSlice?.status === "accepted"),
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
    fullProductModeRequiresProductSpec:
      !fullProductMode ||
      Boolean(productReadiness.productSpec.exists && productReadiness.productSpec.registered && productReadiness.productSpec.unchanged),
    fullProductReadinessRecorded:
      !fullProductMode || Boolean(productReadiness && productReadiness.blockers && productReadiness.commands.manualUrl),
    productReadinessBlocksIncompleteTarget:
      !fullProductMode ||
      productReadiness.passed ||
      (finalOutcome === "blocked" && productReadiness.blockers.length > 0),
    productProbeArtifactRecorded:
      !fullProductMode ||
      !productReadiness.passed ||
      Boolean(
        productReadiness.commandResults.start.probeOutputPath &&
          fs.existsSync(productReadiness.commandResults.start.probeOutputPath) &&
          productReadiness.commandResults.start.probeMarkdownPath &&
          fs.existsSync(productReadiness.commandResults.start.probeMarkdownPath),
      ),
    productProbeChecksPassed:
      !fullProductMode ||
      !productReadiness.passed ||
      Boolean(
        productReadiness.commandResults.start.probes?.ui?.passed &&
          productReadiness.commandResults.start.probes?.api?.passed &&
          productReadiness.commandResults.start.probes?.api?.jsonFieldsPresent?.openTotalCents === true &&
          productReadiness.commandResults.start.probes?.markPaid?.passed,
      ),
    finalTargetSnapshotsArchived:
      !historyEnabled ||
      Boolean(
        finalTargetSnapshots?.invoiceApi?.exists &&
          finalTargetSnapshots?.invoiceDashboard?.exists &&
          fs.existsSync(finalTargetSnapshots.invoiceApi.path) &&
          fs.existsSync(finalTargetSnapshots.invoiceDashboard.path),
      ),
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
    acceptedHasNoActiveBlockingEscalations:
      finalOutcome !== "accepted" ||
      !finalSnapshot.activeEscalations.some((item) => ["blocker", "human_required", "critical"].includes(item.level)),
    blockedHasVisibleReason:
      finalOutcome === "accepted" ||
      finalSnapshot.activeEscalations.some((item) => ["blocker", "human_required", "critical"].includes(item.level)),
  },
  artifacts: artifactPaths,
};

fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
if (fullProductMode) {
  fs.writeFileSync(productReadinessPath, `${JSON.stringify(productReadiness, null, 2)}\n`, "utf8");
  fs.writeFileSync(productReadinessMarkdownPath, renderProductReadinessMarkdown(productReadiness), "utf8");
}
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
    command: fullProductMode
      ? resetBeforeRun
        ? "npm run smoke:live-agent:full"
        : "npm run demo:live-agent:full"
      : "npm run demo:live-agent:run",
    mode,
    driver,
    summary: summaryPath,
    fault: faultMode,
    finalOutcome,
    finalReason,
    outcomeClassification,
    productReadiness: fullProductMode ? productReadiness : undefined,
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
  fullProductMode,
  productReadiness,
  finalSnapshot,
  finalSlice,
  verifyRuns,
  turns,
  staleRecovery,
  supervisedRecovery,
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
      explanation: fullProductMode
        ? "The full-product run passed product readiness after worker evidence, independent review, deterministic verification, and final product checks."
        : "The selected slice reached accepted status after worker evidence, independent review, and deterministic verification.",
      evidence: {
        ...evidence,
        acceptedVerifyRun: latestVerify?.accepted ? latestVerify : undefined,
        reviewStatus: finalSlice?.reviewResult?.status,
        productReadiness: fullProductMode ? productReadiness : undefined,
      },
    };
  }

  if (fullProductMode && productReadiness && !productReadiness.passed) {
    return {
      code: "product_not_ready",
      severity: "blocked",
      explanation: "The live smoke accepted at least one implementation slice, but the invoice dashboard product is not locally runnable yet.",
      evidence: {
        ...evidence,
        productReadiness: {
          artifact: productReadinessPath,
          blockers: productReadiness.blockers,
          commands: productReadiness.commands,
        },
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

  if (supervisedRecovery.detectedAtTurn && !supervisedRecovery.revivedAtTurn && !supervisedRecovery.restartedAtTurn) {
    return {
      code: "recovery_blocked",
      severity: "blocked",
      explanation: "A failed worker run was detected, but supervised recovery did not attempt revive or restart before the run stopped.",
      evidence: {
        ...evidence,
        supervisedRecovery,
      },
    };
  }

  if (
    faultMode === "supervised-revive" &&
    supervisedRecovery.detectedAtTurn &&
    supervisedRecovery.revivedAtTurn &&
    finalOutcome !== "accepted"
  ) {
    return {
      code: "recovery_blocked",
      severity: "blocked",
      explanation: "The supervised recovery path ran, but the revived/restarted work did not reach accepted status.",
      evidence: {
        ...evidence,
        supervisedRecovery,
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
      "reviveOutputPath",
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
      latestRecoveryRevive: summary.artifacts.recoveryRevive,
      productReadiness: summary.artifacts.productReadiness,
      productProbe: summary.artifacts.productProbe,
      finalInvoiceApi: summary.artifacts.finalInvoiceApi,
      finalInvoiceDashboard: summary.artifacts.finalInvoiceDashboard,
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
  if (key.includes("finalInvoice")) return "target-snapshot";
  if (key.includes("product")) return "product";
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
    recoveryRunFocus: "Run focus packet captured before supervised recovery intervention.",
    recoverySliceFocus: "Slice focus packet captured before supervised recovery intervention.",
    recoveryRevive: "Supervised recovery same-session revive output.",
    recoveryRestartAfterRevive: "Supervised recovery restart fallback output.",
    contextWorkerPacket: "Worker resume packet generated at context handoff.",
    contextReviewerPacket: "Reviewer resume packet generated at context handoff.",
    contextVerifierPacket: "Verifier resume packet generated at context handoff.",
    contextOverseerPacket: "Overseer resume packet generated at context handoff.",
    contextRecoveryPacket: "Recovery resume packet generated at context handoff.",
    lowSignalWarning: "Lane-scoped low-signal/proof-churn warning artifact.",
    productReadiness: "Full-product readiness JSON with final commands, checks, and blockers.",
    productReadinessMarkdown: "Human-readable full-product readiness report.",
    productTestOutput: "Invoice dashboard npm test output from the product readiness check.",
    productStartOutput: "Invoice dashboard npm start output and local probe result from the product readiness check.",
    productProbe: "Structured HTML/API probe evidence from the final invoice dashboard readiness check.",
    productProbeMarkdown: "Human-readable HTML/API probe evidence from the final invoice dashboard readiness check.",
    finalInvoiceApi: "Final invoice API target snapshot captured at run completion.",
    finalInvoiceDashboard: "Final invoice dashboard target snapshot captured at run completion.",
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
  const finalTargetsDir = path.join(runDir, "final-targets");
  return {
    root: historyRoot,
    runDir,
    runsIndex: path.join(historyRoot, "runs.json"),
    summary: path.join(runDir, "summary.json"),
    artifactIndex: path.join(runDir, "artifact-index.json"),
    artifactIndexMarkdown: path.join(runDir, "artifact-index.md"),
    finalTargetsDir,
    finalInvoiceApi: path.join(finalTargetsDir, "invoice-api"),
    finalInvoiceDashboard: path.join(finalTargetsDir, "invoice-dashboard"),
    originalSummary: summaryPath,
    originalArtifactIndex: artifactIndexPath,
    originalArtifactIndexMarkdown: artifactIndexMarkdownPath,
  };
}

function snapshotFinalTargets(paths) {
  return {
    invoiceApi: copyFinalTargetSnapshot(invoiceTarget, paths.finalInvoiceApi),
    invoiceDashboard: copyFinalTargetSnapshot(dashboardTarget, paths.finalInvoiceDashboard),
  };
}

function copyFinalTargetSnapshot(source, destination) {
  fs.rmSync(destination, { recursive: true, force: true });
  if (!fs.existsSync(source)) {
    return {
      source,
      path: destination,
      exists: false,
      reason: "source target does not exist",
    };
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (entryPath) => ![".git", "node_modules"].includes(path.basename(entryPath)),
  });
  return {
    source,
    path: destination,
    exists: fs.existsSync(destination),
    excluded: [".git", "node_modules"],
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
    finalTargets: summary.history.finalTargets,
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

function readCoverageSummary() {
  const store = new SwarmStore(workspace);
  try {
    return buildCoverage(store);
  } finally {
    store.close();
  }
}

function summarizeOutcomeVsCoverage(outcome, coverage) {
  const coverageState = coverage.interpretation?.state ?? "empty";
  const coverageText = `${coverage.totals.done}/${coverage.totals.total}`;
  if (outcome === "accepted" && coverageState === "complete") {
    return {
      state: "accepted_complete",
      severity: "success",
      headline: "Run accepted and indexed requirements are complete",
      detail: `${coverageText} indexed FR/AC refs are done.`,
    };
  }
  if (outcome === "accepted") {
    return {
      state: "accepted_partial",
      severity: "warning",
      headline: "Run accepted for selected scope; indexed requirement coverage is partial",
      detail: `${coverageText} indexed FR/AC refs are done. The accepted run proves its selected slices and readiness gate, not every registered requirement.`,
    };
  }
  return {
    state: outcome ? "not_accepted" : "unknown",
    severity: outcome === "human_required" ? "danger" : "warning",
    headline: `Run outcome is ${outcome ?? "unknown"}`,
    detail: `${coverageText} indexed FR/AC refs are done.`,
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
  const resetArgs = [resetScript];
  if (!samePath(workspace, defaultWorkspace)) {
    resetArgs.push("--workspace", workspace);
  }
  if (resetBeforeRun) {
    resetArgs.push("--stop-related-processes");
  }
  execFileSync(process.execPath, resetArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
}

function ensureWorkspaceInitialized() {
  if (!fs.existsSync(path.join(workspace, ".swarm", "state.db"))) {
    throw new Error(`Live smoke workspace is not initialized: ${workspace}. Run npm run demo:live-agent:reset first.`);
  }
}

function assertFullProductPrerequisites() {
  if (!fs.existsSync(productSpec)) {
    throw new Error(`Full-product mode requires copied product spec: ${productSpec}. Run npm run demo:live-agent:reset first.`);
  }
  const snapshot = observe(80);
  const productSource = findProductSpecSource(snapshot.sources);
  if (!productSource) {
    throw new Error(
      `Full-product mode requires the invoice dashboard product spec to be registered as a source: ${productSpec}`,
    );
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
  if (faultMode === "supervised-revive") {
    return [
      {
        mode: faultMode,
        expectedDetection: "a stalled child worker is terminated, recorded, resumed by session id, and then gated by review and verification",
      },
    ];
  }
  return [];
}

function observe(events) {
  return JSON.parse(runSwarm(["observe", "--events", String(events)]));
}

function commandSummaryHasRecoverableDependencyBlock(summary) {
  const results = Array.isArray(summary?.results) ? summary.results : [];
  if (results.length === 0) return false;
  return results.every((result) => {
    if (!["blocked", "failed"].includes(result?.status)) return false;
    const reason = String(result?.reason ?? "");
    return /Source dependencies are not satisfied|Missing accepted refs/i.test(reason);
  });
}

function recordDependencyWarningClearances(readiness, snapshot, turn) {
  const dependencyCleared = clearSatisfiedDashboardDependencyWarnings(readiness, snapshot, turn);
  if (dependencyCleared.length > 0) {
    dependencyWarningClearances.push(...dependencyCleared);
    turns.push({
      turn,
      kind: "dependency-warning-clearance",
      clearedEscalations: dependencyCleared,
      reason: "Dashboard dependency gate is now satisfied.",
    });
  }

  const diagnosticCleared = clearAcceptedReviewerCommandWarnings(readiness, snapshot, turn);
  if (diagnosticCleared.length > 0) {
    diagnosticWarningClearances.push(...diagnosticCleared);
    turns.push({
      turn,
      kind: "diagnostic-warning-clearance",
      clearedEscalations: diagnosticCleared,
      reason: "Final product readiness passed; reviewer command-policy warnings are historical diagnostics.",
    });
  }
}

function recordAcceptedSliceWarningClearances(slice, activeEscalations, turn) {
  const acceptedCleared = clearAcceptedSliceHistoricalWarnings(slice, activeEscalations, turn);
  if (acceptedCleared.length === 0) return;
  acceptedSliceWarningClearances.push(...acceptedCleared);
  turns.push({
    turn,
    kind: "accepted-slice-warning-clearance",
    sliceId: slice.id,
    clearedEscalations: acceptedCleared,
    reason: "Slice is accepted; historical worker/reviewer/command warnings for this slice are resolved.",
  });
}

function recordAllAcceptedSliceWarningClearances(snapshot, turn) {
  const acceptedSlices = Array.isArray(snapshot?.slices) ? snapshot.slices.filter((slice) => slice.status === "accepted") : [];
  const activeEscalations = Array.isArray(snapshot?.activeEscalations) ? snapshot.activeEscalations : [];
  for (const slice of acceptedSlices) {
    recordAcceptedSliceWarningClearances(slice, activeEscalations, turn);
  }
}

function clearAcceptedSliceHistoricalWarnings(slice, activeEscalations, turn) {
  if (!slice || slice.status !== "accepted") return [];
  const clearable = activeEscalations.filter((escalation) => {
    if (escalation.status !== "active") return false;
    if (!["warning", "blocker"].includes(escalation.level)) return false;
    if (escalation.entityType !== "slice" || escalation.entityId !== slice.id) return false;
    const haystack = `${escalation.message ?? ""} ${escalation.reason ?? ""} ${escalation.createdBy ?? ""}`;
    return isAcceptedSliceHistoricalWarning(haystack);
  });
  return clearable.map((escalation) => {
    const reason = "Slice is accepted after review and deterministic verification; historical warning/blocker is resolved.";
    try {
      runSwarm(["escalations", "clear", escalation.id, "--reason", reason, "--actor", "live-acceptance-loop"]);
      return {
        turn,
        sliceId: slice.id,
        id: escalation.id,
        level: escalation.level,
        message: escalation.message,
        cleared: true,
        reason,
      };
    } catch (error) {
      return {
        turn,
        sliceId: slice.id,
        id: escalation.id,
        level: escalation.level,
        message: escalation.message,
        cleared: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

function isAcceptedSliceHistoricalWarning(text) {
  if (/low-signal|proof-churn/i.test(text)) return false;
  return (
    /failed worker|worker.*failed|worker attempt/i.test(text) ||
    /no worker|missing worker|no review|missing review|no command|missing command/i.test(text) ||
    /stale|unrelated worktree|existing warning escalation|active backend slice/i.test(text) ||
    /command.*policy[- ]?rejected|read-only (?:code )?inspection/i.test(text) ||
    /git status.*modified.*untracked.*\.swarm|git.*permission warnings?|unable to access .*git\/ignore|dubious ownership/i.test(text)
  );
}

function clearSatisfiedDashboardDependencyWarnings(readiness, snapshot, turn) {
  if (!fullProductMode) return [];
  const activeEscalations = Array.isArray(snapshot?.activeEscalations) ? snapshot.activeEscalations : [];
  const acceptedSliceIds = new Set(
    (Array.isArray(snapshot?.slices) ? snapshot.slices : [])
      .filter((slice) => slice.status === "accepted")
      .map((slice) => slice.id),
  );
  const activeSliceIds = new Set(
    (Array.isArray(snapshot?.slices) ? snapshot.slices : [])
      .filter((slice) => isActiveSlice(slice))
      .map((slice) => slice.id),
  );
  const dependencySatisfied = Boolean(readiness?.dashboardDependencies?.satisfied);
  const productAccepted = Boolean(readiness?.passed);
  const clearable = activeEscalations
    .map((escalation) => {
      if (escalation.status !== "active") return undefined;
      if (escalation.entityType !== "harness" || escalation.entityId !== scenarioEntityId) return undefined;
      const message = String(escalation.message ?? "");
      if (dependencySatisfied && isDashboardDependencyPlanningMessage(message)) {
        return {
          escalation,
          reason: "Dashboard dependency gate is satisfied; declared backend refs are accepted.",
        };
      }
      if (dependencySatisfied && isDashboardPullPlanningWarning(message)) {
        return {
          escalation,
          reason: "Dashboard planning warning is stale; backend prerequisite slices are resolved.",
        };
      }
      if (isAcceptedSlicePlanningBlocker(message, acceptedSliceIds, activeSliceIds)) {
        return {
          escalation,
          reason: "Referenced slice is accepted and no longer blocked in harness state.",
        };
      }
      if (productAccepted && isHistoricalPlanningNoise(message)) {
        return {
          escalation,
          reason: "Final product readiness passed; historical planning warning is no longer active.",
        };
      }
      return undefined;
    })
    .filter(Boolean);
  return clearable.map(({ escalation, reason }) => {
    try {
      runSwarm(["escalations", "clear", escalation.id, "--reason", reason, "--actor", "live-acceptance-loop"]);
      return {
        turn,
        id: escalation.id,
        level: escalation.level,
        message: escalation.message,
        cleared: true,
        reason,
      };
    } catch (error) {
      return {
        turn,
        id: escalation.id,
        level: escalation.level,
        message: escalation.message,
        cleared: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

function isDashboardDependencyPlanningMessage(message) {
  return (
    /Invoice Dashboard (?:source|Requirements)/i.test(message) &&
    /blocked/i.test(message) &&
    /(backend|accepted|prerequisite refs|missing accepted refs|missing accepted backend prerequisite refs)/i.test(message)
  );
}

function isDashboardPullPlanningWarning(message) {
  return (
    /Do not pull .*Dashboard/i.test(message) ||
    /Do not pull dashboard work/i.test(message) ||
    /dashboard source .*pullable/i.test(message) ||
    /actionableState.*dashboard source.*pullable/i.test(message)
  );
}

function isAcceptedSlicePlanningBlocker(message, acceptedSliceIds, activeSliceIds) {
  const refs = [...message.matchAll(/\bSLICE-[a-f0-9]+\b/gi)].map((match) => match[0]);
  if (refs.length === 0) return false;
  if (!refs.every((id) => acceptedSliceIds.has(id) && !activeSliceIds.has(id))) return false;
  return /blocker|blocked|review.*not completed|independent review/i.test(message);
}

function isHistoricalPlanningNoise(message) {
  return (
    /historical blocker\/warning/i.test(message) ||
    /earlier dashboard dependency blocking/i.test(message) ||
    /historical dashboard prerequisite warnings/i.test(message) ||
    /dashboard prerequisite warnings appear stale/i.test(message) ||
    /existing warning escalations?/i.test(message) ||
    /authoritative snapshot .*not mark.*blocking/i.test(message) ||
    /does not block .*dispatch/i.test(message) ||
    /claims dashboard prerequisites are missing/i.test(message) ||
    /claims missing dashboard prerequisites/i.test(message) ||
    /mark(?:s|ed)? (?:that )?blocker stale/i.test(message) ||
    /mark(?:s|ed)? it stale/i.test(message) ||
    /do not treat it as blocking/i.test(message) ||
    /git permission warnings?|untracked \.swarm|modified implementation\/test files/i.test(message)
  );
}

function clearAcceptedReviewerCommandWarnings(readiness, snapshot, turn) {
  if (!fullProductMode || !readiness?.passed) return [];
  const activeEscalations = Array.isArray(snapshot?.activeEscalations) ? snapshot.activeEscalations : [];
  const clearable = activeEscalations.filter((escalation) => {
    if (escalation.status !== "active" || escalation.level !== "warning") return false;
    return isReviewerCommandPolicyWarning(`${escalation.message ?? ""} ${escalation.reason ?? ""}`);
  });
  return clearable.map((escalation) => {
    const reason = "Final product readiness and deterministic verification passed; this reviewer command-policy note is historical diagnostic noise.";
    try {
      runSwarm(["escalations", "clear", escalation.id, "--reason", reason, "--actor", "live-acceptance-loop"]);
      return {
        turn,
        id: escalation.id,
        level: escalation.level,
        entityType: escalation.entityType,
        entityId: escalation.entityId,
        message: escalation.message,
        cleared: true,
        reason,
      };
    } catch (error) {
      return {
        turn,
        id: escalation.id,
        level: escalation.level,
        entityType: escalation.entityType,
        entityId: escalation.entityId,
        message: escalation.message,
        cleared: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

function isReviewerCommandPolicyWarning(text) {
  return (
    /reviewer command execution/i.test(text) ||
    /direct reviewer command verification/i.test(text) ||
    /command.*policy[- ]?rejected/i.test(text) ||
    /read-only (?:code )?inspection/i.test(text)
  );
}

function runSwarm(commandArgs) {
  return execFileSync(process.execPath, [cli, ...commandArgs], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SWARM_LIVE_FAULT: faultMode, SWARM_WORKSPACE: workspace },
    maxBuffer: SWARM_CLI_MAX_BUFFER,
  });
}

function runSwarmCapture(commandArgs) {
  const result = spawnSync(process.execPath, [cli, ...commandArgs], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SWARM_LIVE_FAULT: faultMode, SWARM_WORKSPACE: workspace },
    windowsHide: true,
    maxBuffer: SWARM_CLI_MAX_BUFFER,
  });
  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ? result.error.message : undefined,
  };
}

function writeCommandCapture(outputPath, capture) {
  fs.writeFileSync(
    outputPath,
    [
      `exitCode: ${capture.status ?? "unknown"}`,
      `ok: ${capture.ok ? "true" : "false"}`,
      capture.error ? `error: ${capture.error}` : undefined,
      "--- stdout ---",
      capture.stdout.trimEnd(),
      "--- stderr ---",
      capture.stderr.trimEnd(),
      "",
    ]
      .filter((line) => line !== undefined)
      .join("\n"),
    "utf8",
  );
}

function writeJsonCommandCapture(outputPath, capture) {
  let payload;
  try {
    payload = JSON.parse(capture.stdout);
  } catch {
    payload = {
      ok: capture.ok,
      status: capture.status,
      error: capture.error,
      stdout: capture.stdout,
      stderr: capture.stderr,
    };
  }
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function handleSupervisedRecovery(turn, snapshot) {
  const candidate = findSupervisedRecoveryCandidate(snapshot);
  if (!candidate) return undefined;

  const { run, slice, reason } = candidate;
  supervisedRecovery.detectedAtTurn ??= turn;
  supervisedRecovery.sliceId ??= slice.id;
  supervisedRecovery.recoveredRunId = run.id;
  if (!supervisedRecovery.attemptedRunIds.includes(run.id)) supervisedRecovery.attemptedRunIds.push(run.id);

  const turnRecord = {
    turn,
    kind: "supervised-recovery",
    sliceId: slice.id,
    recoveredRunId: run.id,
    recoveredRunStatus: run.status,
    detectedReason: reason,
    sessionId: run.sessionId,
    focusRunOutputPath: undefined,
    focusSliceOutputPath: undefined,
    reviveOutputPath: undefined,
    restartOutputPath: undefined,
    revivedRunId: undefined,
    revivedRunStatus: undefined,
    restartedRunId: undefined,
    restartedRunStatus: undefined,
  };

  const runFocusCapture = runSwarmCapture(["inspect", "run", run.id, "--json"]);
  supervisedRecovery.focusRunOutputPath = path.join(artifactsPath, `turn-${turn}-recovery-run-focus.json`);
  writeJsonCommandCapture(supervisedRecovery.focusRunOutputPath, runFocusCapture);
  turnRecord.focusRunOutputPath = supervisedRecovery.focusRunOutputPath;
  turnRecord.focusRunCommandOk = runFocusCapture.ok;

  const sliceFocusCapture = runSwarmCapture(["inspect", "slice", slice.id, "--json"]);
  supervisedRecovery.focusSliceOutputPath = path.join(artifactsPath, `turn-${turn}-recovery-slice-focus.json`);
  writeJsonCommandCapture(supervisedRecovery.focusSliceOutputPath, sliceFocusCapture);
  turnRecord.focusSliceOutputPath = supervisedRecovery.focusSliceOutputPath;
  turnRecord.focusSliceCommandOk = sliceFocusCapture.ok;

  let after = snapshot;
  if (run.sessionId && !supervisedRecovery.revivedAtTurn) {
    const capture = runSwarmCapture(["recovery", "revive", run.id, "--actor", supervisedRecovery.reviveActor]);
    supervisedRecovery.reviveOutputPath = path.join(artifactsPath, `turn-${turn}-recovery-revive.txt`);
    writeCommandCapture(supervisedRecovery.reviveOutputPath, capture);
    supervisedRecovery.revivedAtTurn = turn;
    turnRecord.reviveOutputPath = supervisedRecovery.reviveOutputPath;
    turnRecord.reviveCommandOk = capture.ok;
    after = observe(240);
    const revivedRun = findLatestWorkerRunAfter(after, slice.id, run.startedAt, run.id);
    supervisedRecovery.revivedRunId = revivedRun?.id;
    turnRecord.revivedRunId = revivedRun?.id;
    turnRecord.revivedRunStatus = revivedRun?.status;
    if (revivedRun?.status === "completed") return turnRecord;
  }

  if (!supervisedRecovery.restartedAtTurn) {
    const restartSourceRunId = turnRecord.revivedRunId ?? run.id;
    const capture = runSwarmCapture([
      "recovery",
      "restart",
      restartSourceRunId,
      "--actor",
      supervisedRecovery.restartActor,
      "--driver",
      driver,
    ]);
    supervisedRecovery.restartOutputPath = path.join(artifactsPath, `turn-${turn}-recovery-restart-after-revive.txt`);
    writeCommandCapture(supervisedRecovery.restartOutputPath, capture);
    supervisedRecovery.restartedAtTurn = turn;
    turnRecord.restartOutputPath = supervisedRecovery.restartOutputPath;
    turnRecord.restartCommandOk = capture.ok;
    after = observe(240);
    const restartedRun = findLatestWorkerRunAfter(after, slice.id, run.startedAt, restartSourceRunId);
    supervisedRecovery.restartedRunId = restartedRun?.id;
    turnRecord.restartedRunId = restartedRun?.id;
    turnRecord.restartedRunStatus = restartedRun?.status;
  }

  return turnRecord;
}

function findSupervisedRecoveryCandidate(snapshot) {
  const slicesById = new Map(snapshot.slices.map((slice) => [slice.id, slice]));
  const workerRuns = snapshot.agentRuns
    .filter((run) => {
      if (run.role !== "worker") return false;
      if (["failed", "stale"].includes(run.status)) return true;
      return run.status === "running" && latestRunFailureEvent(snapshot, run)?.type === "worker.child_idle_timeout";
    })
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));

  for (const run of workerRuns) {
    const slice = slicesById.get(run.sliceId);
    if (!slice || ["accepted", "closed"].includes(slice.status)) continue;
    if (supervisedRecovery.restartedAtTurn && supervisedRecovery.sliceId === slice.id) continue;
    if (hasLaterCompletedWorker(snapshot, run)) continue;
    const recentFailureEvent = latestRunFailureEvent(snapshot, run);
    const reason =
      recentFailureEvent?.type === "worker.child_idle_timeout" || recentFailureEvent?.payload?.idleTimedOut === true
        ? "child idle timeout"
        : run.resultPath
          ? "failed worker run"
          : "failed worker run without structured result";
    return { run, slice, reason };
  }
  return undefined;
}

function findLatestWorkerRunAfter(snapshot, sliceId, startedAfter, excludedRunId) {
  const startedAfterMs = Date.parse(startedAfter ?? "");
  return snapshot.agentRuns
    .filter((run) => {
      if (run.role !== "worker" || run.sliceId !== sliceId || run.id === excludedRunId) return false;
      if (Number.isFinite(startedAfterMs) && Date.parse(run.startedAt) < startedAfterMs) return false;
      return true;
    })
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
    .at(0);
}

function hasLaterCompletedWorker(snapshot, run) {
  const runStartedAt = Date.parse(run.startedAt);
  return snapshot.agentRuns.some((candidate) => {
    if (candidate.role !== "worker" || candidate.sliceId !== run.sliceId || candidate.id === run.id) return false;
    if (candidate.status !== "completed") return false;
    return !Number.isFinite(runStartedAt) || Date.parse(candidate.startedAt) >= runStartedAt;
  });
}

function latestRunFailureEvent(snapshot, run) {
  return snapshot.recentEvents
    .filter((event) => {
      if (!["worker.child_idle_timeout", "worker.completed", "recovery.revive_completed", "recovery.restart_completed"].includes(event.type)) {
        return false;
      }
      if (event.payload?.runId === run.id || event.entityId === run.id || event.payload?.previousRunId === run.id) return true;
      return event.type === "worker.child_idle_timeout" && event.actor === run.actor && event.entityId === run.sliceId;
    })
    .at(-1);
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

function findProductSpecSource(sources) {
  const expected = path.resolve(productSpec).toLowerCase();
  return sources.find((source) => path.resolve(source.uri).toLowerCase() === expected);
}

function inspectProductReadiness({ runCommands }) {
  const snapshot = observe(120);
  const productSource = findProductSpecSource(snapshot.sources);
  const productSourceMutation = productSource ? inspectSourceMutations([productSource])[0] : undefined;
  const packagePath = path.join(dashboardTarget, "package.json");
  const packageJson = readJsonFile(packagePath);
  const scripts = packageJson && typeof packageJson === "object" && packageJson.scripts ? packageJson.scripts : {};
  const hasTestScript = typeof scripts.test === "string" && scripts.test.trim().length > 0;
  const hasStartScript = typeof scripts.start === "string" && scripts.start.trim().length > 0;
  const manualUrl = "http://127.0.0.1:4321";
  const probeIsolation = runCommands && (hasTestScript || hasStartScript)
    ? createProductProbeWorkspace()
    : {
        strategy: runCommands ? "not-needed" : "commands-disabled",
        sourcePath: dashboardTarget,
        workspacePath: undefined,
        copied: false,
        isolated: false,
        reason: runCommands ? "No product readiness commands were available to isolate." : "Command execution disabled for this readiness pass.",
      };
  const commandWorkspace = probeIsolation.workspacePath ?? dashboardTarget;
  const probeIsolationFailed = runCommands && (hasTestScript || hasStartScript) && !probeIsolation.workspacePath;
  const dashboardSlices = snapshot.slices.filter((slice) => slice.frAcRefs.some((ref) => ref.startsWith("AC-UI")));
  const acceptedDashboardSlices = dashboardSlices.filter((slice) => slice.status === "accepted");
  const activeDashboardSlices = dashboardSlices.filter((slice) => !["accepted", "closed"].includes(slice.status));
  const productReadinessSlices = snapshot.slices.filter((slice) => isProductReadinessSlice(slice));
  const activeProductReadinessSlices = productReadinessSlices.filter((slice) => isActiveSlice(slice));
  const dashboardDependencies = inspectDashboardDependencyGate(snapshot);
  const testResult = runCommands && hasTestScript && !probeIsolationFailed
    ? runNpmScript("test", productTestOutputPath, { cwd: commandWorkspace })
    : {
        command: "npm test",
        attempted: false,
        passed: false,
        outputPath: hasTestScript ? productTestOutputPath : undefined,
        cwd: hasTestScript ? commandWorkspace : undefined,
        reason: probeIsolationFailed
          ? probeIsolation.reason
          : hasTestScript
            ? "Command execution disabled for this readiness pass."
            : "No npm test script is defined.",
      };
  const startResult = runCommands && hasStartScript && !probeIsolationFailed
    ? runStartProbe(manualUrl, productStartOutputPath, productProbePath, productProbeMarkdownPath, {
        cwd: commandWorkspace,
        probeIsolation,
      })
    : {
        command: "npm start",
        attempted: false,
        passed: false,
        manualUrl,
        outputPath: hasStartScript ? productStartOutputPath : undefined,
        cwd: hasStartScript ? commandWorkspace : undefined,
        reason: probeIsolationFailed
          ? probeIsolation.reason
          : hasStartScript
            ? "Command execution disabled for this readiness pass."
            : "No npm start script is defined.",
      };
  const checks = [
    {
      id: "product-spec-present",
      label: "Product spec exists in reset workspace",
      passed: fs.existsSync(productSpec),
      severity: "blocker",
      message: `Expected copied product spec at ${productSpec}.`,
    },
    {
      id: "product-spec-registered",
      label: "Product spec is registered as immutable source",
      passed: Boolean(productSource),
      severity: "blocker",
      message: "The invoice dashboard product spec must be registered as a source before full-product work starts.",
    },
    {
      id: "product-spec-unchanged",
      label: "Product spec hash is unchanged",
      passed: Boolean(productSourceMutation && !productSourceMutation.mutated),
      severity: "blocker",
      message: productSourceMutation?.reason ?? "The product spec source hash could not be checked.",
    },
    {
      id: "dashboard-target-exists",
      label: "Invoice dashboard target exists",
      passed: fs.existsSync(dashboardTarget),
      severity: "blocker",
      message: `Expected dashboard target at ${dashboardTarget}.`,
    },
    {
      id: "dashboard-package-json",
      label: "Invoice dashboard package.json exists",
      passed: Boolean(packageJson),
      severity: "blocker",
      message: `Expected package.json at ${packagePath}.`,
    },
    {
      id: "dashboard-dependencies-accepted",
      label: "Dashboard source dependencies are accepted",
      passed: dashboardDependencies.satisfied,
      severity: "blocker",
      message: dashboardDependencies.dependsOn.length === 0
        ? "No dashboard dependency refs were declared."
        : dashboardDependencies.satisfied
          ? "All declared dashboard dependency refs are accepted."
          : `Missing accepted backend refs: ${dashboardDependencies.missingRefs.join(", ")}.`,
    },
    {
      id: "dashboard-test-script",
      label: "Invoice dashboard has npm test",
      passed: hasTestScript,
      severity: "blocker",
      message: "The final product must expose npm test.",
    },
    {
      id: "dashboard-test-passes",
      label: "Invoice dashboard npm test passes",
      passed: Boolean(testResult.passed),
      severity: "blocker",
      message: testResult.reason ?? "npm test must pass for the final product target.",
    },
    {
      id: "dashboard-start-script",
      label: "Invoice dashboard has npm start",
      passed: hasStartScript,
      severity: "blocker",
      message: "The final product must expose npm start so a human can open the dashboard.",
    },
    {
      id: "dashboard-start-probed",
      label: "Invoice dashboard local URL is probed",
      passed: Boolean(startResult.passed),
      severity: "blocker",
      message: startResult.reason ?? "The dashboard must start locally and respond to browser/API probes.",
    },
    {
      id: "dashboard-slice-accepted",
      label: "Invoice dashboard implementation slice is accepted",
      passed: acceptedDashboardSlices.length > 0,
      severity: "blocker",
      message: "At least one dashboard/UI slice must pass worker, reviewer, and deterministic verification before product acceptance.",
    },
  ];
  const blockers = checks
    .filter((check) => !check.passed && check.severity === "blocker")
    .map((check) => ({ id: check.id, label: check.label, message: check.message }));
  return {
    mode: "full-product",
    generatedAt: new Date().toISOString(),
    productName: "Invoice Operations Dashboard",
    passed: blockers.length === 0,
    productSpec: {
      repoPath: sourceProductSpec,
      workspacePath: productSpec,
      exists: fs.existsSync(productSpec),
      registered: Boolean(productSource),
      sourceId: productSource?.id,
      hash: productSource?.hash,
      unchanged: Boolean(productSourceMutation && !productSourceMutation.mutated),
      mutation: productSourceMutation,
    },
    target: {
      name: "invoice-dashboard",
      path: dashboardTarget,
      exists: fs.existsSync(dashboardTarget),
      packageJson: packagePath,
      packageExists: Boolean(packageJson),
      scripts,
    },
    dashboardDependencies,
    commands: {
      install: "npm install",
      test: "npm test",
      start: "npm start",
      manualUrl,
    },
    probeIsolation,
    commandResults: {
      test: testResult,
      start: startResult,
    },
    dashboardSlices: {
      total: dashboardSlices.length,
      active: activeDashboardSlices.length,
      accepted: acceptedDashboardSlices.length,
      ids: dashboardSlices.map((slice) => ({ id: slice.id, status: slice.status, refs: slice.frAcRefs })),
    },
    productReadinessSlices: {
      total: productReadinessSlices.length,
      active: activeProductReadinessSlices.length,
      ids: productReadinessSlices.map((slice) => ({ id: slice.id, status: slice.status, refs: slice.frAcRefs })),
    },
    checks,
    blockers,
    noFurtherWorkVisible:
      blockers.length > 0 &&
      acceptedDashboardSlices.length > 0 &&
      activeDashboardSlices.length === 0 &&
      activeProductReadinessSlices.length === 0,
  };
}

function ensureProductReadinessWork({ productReadiness, snapshot, turn }) {
  if (!shouldCreateProductReadinessWork(productReadiness)) return undefined;

  const activeReadinessSlice = snapshot.slices.find((slice) => isProductReadinessSlice(slice) && isActiveSlice(slice));
  if (activeReadinessSlice) {
    return {
      turn,
      kind: "product-readiness-work-visible",
      sliceId: activeReadinessSlice.id,
      status: activeReadinessSlice.status,
      refs: activeReadinessSlice.frAcRefs,
      blockers: productReadiness.blockers,
      reason: "Runtime-readiness blockers are already represented by an active product readiness slice.",
    };
  }

  const store = new SwarmStore(workspace);
  try {
    const productSource = findProductSpecSource(store.listSources());
    const target = findDashboardTarget(store);
    if (!productSource || !target) {
      return undefined;
    }

    const selectedRefs = productReadinessRefs.filter((ref) => {
      const lease = store.latestLeaseFor(ref);
      return !lease || lease.status === "released";
    });
    if (selectedRefs.length === 0) {
      return undefined;
    }

    const now = new Date().toISOString();
    let lane = store.firstActiveLaneForTarget(target.id);
    let laneCreated = false;
    if (!lane) {
      lane = {
        id: makeId("lane"),
        name: "Product Readiness Lane: Invoice Dashboard Runtime",
        purpose: "Remove final local-runtime blockers for the invoice dashboard product.",
        focusLabels: ["frontend", "dashboard", "product-readiness", "runtime", "live-smoke"],
        targetId: target.id,
        orchestrator: "live-overseer",
        worktree: target.path,
        state: "active",
        createdAt: now,
        updatedAt: now,
      };
      store.insertLane(lane);
      laneCreated = true;
      store.addEvent(
        createEvent({
          actor: "live-acceptance-loop",
          type: "lane.created",
          entityType: "lane",
          entityId: lane.id,
          payload: {
            reason: "Product readiness blockers needed a visible runtime lane.",
            purpose: lane.purpose,
          },
        }),
      );
    }

    const sourceRef = {
      adapterId: productSource.adapterId,
      kind: productSource.kind,
      uri: productSource.uri,
      title: productSource.title,
      hash: productSource.hash,
      section: "FR-PROD-001",
    };
    const blockerLabels = productReadiness.blockers
      .filter((blocker) => productReadinessBlockerIds.has(blocker.id))
      .map((blocker) => blocker.label);
    const slice = {
      id: makeId("slice"),
      laneId: lane.id,
      targetId: target.id,
      title: "Resolve invoice dashboard product readiness",
      status: "ready",
      sourceRefs: [sourceRef],
      frAcRefs: selectedRefs,
      deliveryQuestion: "Can the invoice dashboard be started locally, expose the browser UI and JSON API, and pass npm test?",
      workPackageType: "runtime_capability",
      minimumMeaningfulOutcome: "removes_blocker",
      scope: [
        "Implement or repair npm start for the dashboard target.",
        "Ensure the local dashboard UI is served by the app entrypoint.",
        "Ensure JSON API endpoints used by the dashboard are served by the same local app.",
        "Ensure npm test passes for the final dashboard target.",
        "Use safe runtime proof: prefer bounded local probes or an exported in-process server test over detached background PowerShell jobs when sandbox policy blocks process cleanup.",
      ],
      outOfScope: [
        "Do not mutate source specs.",
        "Do not replace accepted backend/dashboard behavior with unrelated fixture-only code.",
        "Do not add external services, credentials, or non-local dependencies.",
        "Do not treat a long-running npm start timeout as failure when it prints the expected local URL and separate probes prove the app is serving.",
      ],
      expectedEvidence: [
        "npm test output for invoice-dashboard.",
        "npm start output showing a local URL.",
        "Product readiness probe evidence for browser HTML, /api/summary JSON, and the mark-paid API workflow.",
        "If direct detached-process probing is blocked, include the policy rejection plus an in-process HTTP probe that starts and closes the app safely.",
      ],
      unblockTargets: ["final-product-acceptance", "human-open-dashboard"],
      verificationRequirements: [
        "Run npm test in invoice-dashboard.",
        "Run npm start and probe the browser dashboard URL.",
        "Probe /api/summary for invoiceCount and openTotalCents.",
        "Probe the mark-paid workflow by updating an overdue invoice to paid and confirming summary counts change.",
        "For long-running servers, prove start output separately from a bounded HTTP probe that can cleanly close the server.",
      ],
      createdAt: now,
      updatedAt: now,
    };
    store.insertSlice(slice);

    const leases = selectedRefs.map((frAcRef) => {
      const lease = {
        id: makeId("lease"),
        frAcRef,
        laneId: lane.id,
        sliceId: slice.id,
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
      store.insertLease(lease);
      return lease;
    });

    const dependency = {
      id: makeId("dependency"),
      fromType: "slice",
      fromId: slice.id,
      target: "full product readiness probe",
      reason: "Product readiness slices must prove the final dashboard can be started and opened locally.",
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    store.insertDependency(dependency);

    store.addEvent(
      createEvent({
        actor: "live-acceptance-loop",
        type: "product_readiness.slice_created",
        entityType: "slice",
        entityId: slice.id,
        payload: {
          reason: "Full-product readiness found runtime blockers after dashboard acceptance.",
          blockers: productReadiness.blockers,
          blockerLabels,
          frAcRefs: selectedRefs,
          laneId: lane.id,
          sourceId: productSource.id,
        },
      }),
    );
    store.addEvent(
      createEvent({
        actor: "live-overseer",
        type: "planner.decision",
        entityType: "slice",
        entityId: slice.id,
        payload: {
          decisionType: "serve_product_readiness_slice",
          deliveryQuestion: slice.deliveryQuestion,
          workPackageType: slice.workPackageType,
          minimumMeaningfulOutcome: slice.minimumMeaningfulOutcome,
          selectedScope: selectedRefs,
          sourceRefs: [productSource.id],
          dependenciesConsidered: ["accepted dashboard implementation", "full product readiness probe"],
          readinessEvidence: productReadiness.blockers,
          protocolRules: ["runtime_blockers_become_visible_work", "require_final_product_probe"],
          reason: "Runtime readiness blockers are implementation work, so the harness served a visible slice instead of stopping at hidden blocker state.",
          rejectedAlternatives: [
            {
              action: "stop immediately as product_not_ready",
              reason: "A target-local runtime repair is still available and should be attempted before final blockage.",
            },
          ],
          expectedNextAction: "Dispatch a dashboard worker, review the repair, then run deterministic verification and final product probes.",
          laneId: lane.id,
        },
      }),
    );
    refreshCheckpoint({
      store,
      role: "planner",
      entityType: "slice",
      entityId: slice.id,
      actor: "live-acceptance-loop",
      reason: "Product readiness feedback slice served.",
    });
    refreshCheckpoint({
      store,
      role: "planner",
      entityType: "lane",
      entityId: lane.id,
      actor: "live-acceptance-loop",
      reason: "Product readiness feedback updated lane planning state.",
    });

    return {
      turn,
      kind: "product-readiness-slice-created",
      sliceId: slice.id,
      laneId: lane.id,
      laneCreated,
      blockers: productReadiness.blockers,
      refs: selectedRefs,
      leases: leases.map((lease) => lease.frAcRef),
      reason: "Runtime readiness blockers were converted into a visible implementation slice.",
    };
  } finally {
    store.close();
  }
}

function shouldCreateProductReadinessWork(productReadiness) {
  if (!productReadiness || productReadiness.passed) return false;
  if (!productReadiness.dashboardDependencies?.satisfied) return false;
  if ((productReadiness.dashboardSlices?.accepted ?? 0) < 1) return false;
  return productReadiness.blockers.some((blocker) => productReadinessBlockerIds.has(blocker.id));
}

function findDashboardTarget(store) {
  const resolvedDashboardTarget = path.resolve(dashboardTarget).toLowerCase();
  return store.listTargets().find((target) => {
    const targetPath = path.resolve(target.path).toLowerCase();
    return target.name === "invoice-dashboard" || targetPath === resolvedDashboardTarget || path.basename(target.path) === "invoice-dashboard";
  });
}

function isActiveSlice(slice) {
  return !["accepted", "closed"].includes(slice.status);
}

function isProductReadinessSlice(slice) {
  return Array.isArray(slice.frAcRefs) && slice.frAcRefs.some((ref) => productReadinessRefs.includes(String(ref).toUpperCase()));
}

function inspectDashboardDependencyGate(snapshot) {
  const dependsOn = parseDependsOnRefs(dashboardSpec);
  const acceptedRefs = new Set();
  for (const slice of snapshot.slices) {
    if (slice.status !== "accepted") continue;
    for (const ref of slice.frAcRefs ?? []) {
      acceptedRefs.add(ref);
    }
    for (const lease of slice.leases ?? []) {
      if (lease.status === "completed") {
        acceptedRefs.add(lease.frAcRef);
      }
    }
  }
  const acceptedDependsOn = dependsOn.filter((ref) => acceptedRefs.has(ref));
  const missingRefs = dependsOn.filter((ref) => !acceptedRefs.has(ref));
  return {
    source: dashboardSpec,
    dependsOn,
    acceptedRefs: acceptedDependsOn,
    missingRefs,
    satisfied: dependsOn.length > 0 && missingRefs.length === 0,
  };
}

function parseDependsOnRefs(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf8");
  const match = /^Depends-On:\s*(.+)$/im.exec(content);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return { parseError: error.message };
  }
}

function createProductProbeWorkspace() {
  const probeWorkspace = path.join(artifactsPath, "product-dashboard-probe-workspace");
  try {
    fs.rmSync(probeWorkspace, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(probeWorkspace), { recursive: true });
    fs.cpSync(dashboardTarget, probeWorkspace, {
      recursive: true,
      filter: (source) => {
        const name = path.basename(source);
        return name !== ".git" && name !== "node_modules";
      },
    });
    return {
      strategy: "copied-target",
      sourcePath: dashboardTarget,
      workspacePath: probeWorkspace,
      copied: true,
      isolated: !samePath(probeWorkspace, dashboardTarget),
      skippedDirectories: [".git", "node_modules"],
      reason: "Product readiness commands run against a copied target so workflow probes cannot mutate terminal product state.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      strategy: "copied-target",
      sourcePath: dashboardTarget,
      workspacePath: undefined,
      copied: false,
      isolated: false,
      skippedDirectories: [".git", "node_modules"],
      reason: `Failed to create isolated product probe workspace: ${message}`,
    };
  }
}

function runNpmScript(scriptName, outputPath, options = {}) {
  const command = `npm ${scriptName}`;
  const invocation = npmInvocation(scriptName);
  const cwd = options.cwd ?? dashboardTarget;
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    encoding: "utf8",
    timeout: 30000,
  });
  const output = [
    `$ ${command}`,
    `cwd: ${cwd}`,
    "",
    "## stdout",
    result.stdout ?? "",
    "",
    "## stderr",
    result.stderr ?? "",
    "",
    `status: ${result.status ?? "unknown"}`,
    result.error ? `error: ${result.error.message}` : "",
  ].filter(Boolean).join("\n");
  fs.writeFileSync(outputPath, `${output}\n`, "utf8");
  return {
    command,
    attempted: true,
    passed: result.status === 0,
    status: result.status,
    signal: result.signal,
    outputPath,
    cwd,
    reason: result.status === 0 ? undefined : result.error?.message ?? `npm ${scriptName} exited with status ${result.status}`,
  };
}

function runStartProbe(manualUrl, outputPath, probeOutputPath, probeMarkdownPath, options = {}) {
  const outputFd = fs.openSync(outputPath, "w");
  let child;
  const cwd = options.cwd ?? dashboardTarget;
  const probeIsolation = options.probeIsolation;
  try {
    fs.writeSync(outputFd, `$ npm start\n\n`);
    fs.writeSync(outputFd, `cwd: ${cwd}\n`);
    const invocation = npmInvocation("start");
    child = spawn(invocation.command, invocation.args, {
      cwd,
      stdio: ["ignore", outputFd, outputFd],
      env: {
        ...process.env,
        PORT: "4321",
        HOST: "127.0.0.1",
      },
    });

    const uiProbe = waitForHttp(`${manualUrl}/`, {
      label: "dashboard-html",
      expectText: "Invoice Operations Dashboard",
      timeoutMs: 7000,
    });
    const apiProbe = uiProbe.passed
      ? waitForHttp(`${manualUrl}/api/summary`, {
          label: "dashboard-summary-api",
          expectJsonFields: ["invoiceCount", "openTotalCents"],
          timeoutMs: 3000,
        })
      : { passed: false, reason: "Skipped API probe because UI probe failed." };
    const markPaidProbe = apiProbe.passed
      ? runMarkPaidProbe(manualUrl)
      : { passed: false, reason: "Skipped mark-paid workflow because summary API probe failed." };
    const probeArtifact = {
      generatedAt: new Date().toISOString(),
      command: "npm start",
      cwd,
      productTarget: dashboardTarget,
      probeIsolation,
      manualUrl,
      passed: uiProbe.passed && apiProbe.passed && markPaidProbe.passed,
      probes: {
        ui: uiProbe,
        api: apiProbe,
        markPaid: markPaidProbe,
      },
    };
    fs.writeFileSync(probeOutputPath, `${JSON.stringify(probeArtifact, null, 2)}\n`, "utf8");
    fs.writeFileSync(probeMarkdownPath, renderProductProbeMarkdown(probeArtifact), "utf8");
    fs.writeSync(outputFd, `\n\n## probes\n${JSON.stringify(probeArtifact, null, 2)}\n`);
    return {
      command: "npm start",
      attempted: true,
      passed: uiProbe.passed && apiProbe.passed && markPaidProbe.passed,
      manualUrl,
      outputPath,
      probeOutputPath,
      probeMarkdownPath,
      cwd,
      probeIsolation,
      probes: {
        ui: uiProbe,
        api: apiProbe,
        markPaid: markPaidProbe,
      },
      reason: uiProbe.passed && apiProbe.passed && markPaidProbe.passed ? undefined : markPaidProbe.reason ?? apiProbe.reason ?? uiProbe.reason,
    };
  } finally {
    if (child && !child.killed) {
      terminateProcessTree(child);
    }
    fs.closeSync(outputFd);
  }
}

function npmInvocation(scriptName) {
  if (process.platform === "win32") {
    const npmCliPath = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (fs.existsSync(npmCliPath)) {
      return { command: process.execPath, args: [npmCliPath, scriptName] };
    }
  }
  return { command: "npm", args: [scriptName] };
}

function runMarkPaidProbe(manualUrl) {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `const manualUrl = ${JSON.stringify(manualUrl)};
async function readJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.text();
  let json;
  try {
    json = JSON.parse(body);
  } catch (error) {
    throw new Error(url + " returned non-JSON: " + (error && error.message ? error.message : String(error)));
  }
  if (!response.ok) {
    throw new Error(url + " returned HTTP " + response.status + ": " + body.slice(0, 200));
  }
  return json;
}
try {
  const beforeSummary = await readJson(manualUrl + "/api/summary");
  const overduePayload = await readJson(manualUrl + "/api/invoices?status=overdue");
  const overdue = normalizeInvoiceList(overduePayload);
  const candidate = Array.isArray(overdue) && overdue.length > 0 ? overdue[0] : undefined;
  if (!candidate || !candidate.id) {
    throw new Error("No overdue invoice was available for the mark-paid workflow probe.");
  }
  const patchedPayload = await readJson(manualUrl + "/api/invoices/" + encodeURIComponent(candidate.id) + "/status", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "paid" })
  });
  const patched = normalizeInvoice(patchedPayload);
  const afterSummary = await readJson(manualUrl + "/api/summary");
  const paidCountIncreased = afterSummary.paidCount === beforeSummary.paidCount + 1;
  const overdueCountDecreased = afterSummary.overdueCount === beforeSummary.overdueCount - 1;
  const patchedPaid = patched.status === "paid";
  const passed = paidCountIncreased && overdueCountDecreased && patchedPaid;
  console.log(JSON.stringify({
    label: "mark-paid-workflow",
    url: manualUrl + "/api/invoices/" + candidate.id + "/status",
    passed,
    status: 200,
    candidate: { id: candidate.id, previousStatus: candidate.status },
    patched: { id: patched.id, status: patched.status },
    beforeSummary,
    afterSummary,
    paidCountIncreased,
    overdueCountDecreased,
    reason: passed ? undefined : "Mark-paid workflow did not update paid/overdue summary counts as expected."
  }));
  process.exit(passed ? 0 : 4);
} catch (error) {
  console.log(JSON.stringify({
    label: "mark-paid-workflow",
    url: manualUrl + "/api/invoices/:id/status",
    passed: false,
    reason: error && error.message ? error.message : String(error)
  }));
  process.exit(1);
}

function normalizeInvoiceList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.invoices)) return payload.invoices;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function normalizeInvoice(payload) {
  if (payload?.invoice && typeof payload.invoice === "object") return payload.invoice;
  if (payload?.item && typeof payload.item === "object") return payload.item;
  return payload;
}`,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  return parseProbeOutput(result.stdout, {
    label: "mark-paid-workflow",
    url: `${manualUrl}/api/invoices/:id/status`,
    fallbackReason: (result.stderr || result.stdout || `probe exited ${result.status}`).trim(),
  });
}

function terminateProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      child.kill();
    } catch {
      // The process may already be gone after taskkill.
    }
    child.unref();
    return;
  }
  child.kill();
  child.unref();
}

function waitForHttp(url, { label, expectText, expectJsonFields = [], timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let lastResult = {
    label,
    url,
    passed: false,
    expectedText: expectText,
    expectedJsonFields: expectJsonFields,
    reason: "No response before timeout.",
  };
  while (Date.now() < deadline) {
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `const url = ${JSON.stringify(url)};
const expectText = ${JSON.stringify(expectText)};
const expectedJsonFields = ${JSON.stringify(expectJsonFields)};
try {
  const response = await fetch(url);
  const body = await response.text();
  let json;
  let jsonParseError;
  try {
    json = JSON.parse(body);
  } catch (error) {
    jsonParseError = error && error.message ? error.message : String(error);
  }
  const missingJsonFields = expectedJsonFields.filter((field) => !json || !Object.prototype.hasOwnProperty.call(json, field));
  const textMatched = !expectText || body.includes(expectText);
  const passed = response.ok && textMatched && missingJsonFields.length === 0;
  const jsonFieldsPresent = Object.fromEntries(expectedJsonFields.map((field) => [field, Boolean(json && Object.prototype.hasOwnProperty.call(json, field))]));
  const probe = {
    label: ${JSON.stringify(label)},
    url,
    passed,
    status: response.status,
    ok: response.ok,
    contentType: response.headers.get("content-type"),
    expectedText: expectText || undefined,
    textMatched,
    expectedJsonFields,
    jsonFieldsPresent,
    missingJsonFields,
    jsonPreview: json && typeof json === "object" ? Object.fromEntries(Object.entries(json).slice(0, 10)) : undefined,
    jsonParseError: expectedJsonFields.length > 0 ? jsonParseError : undefined,
    bodySnippet: body.slice(0, 500),
    reason: passed ? undefined : (!response.ok ? "HTTP " + response.status : (!textMatched ? "Missing expected text: " + expectText : "Missing expected JSON fields: " + missingJsonFields.join(", "))),
  };
  console.log(JSON.stringify(probe));
  if (!passed) {
    process.exit(4);
  }
  process.exit(0);
} catch (error) {
  console.log(JSON.stringify({
    label: ${JSON.stringify(label)},
    url,
    passed: false,
    expectedText: expectText || undefined,
    expectedJsonFields,
    reason: error && error.message ? error.message : String(error)
  }));
  process.exit(1);
}`,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    const parsed = parseProbeOutput(result.stdout, {
      label,
      url,
      expectedText: expectText,
      expectedJsonFields: expectJsonFields,
      fallbackReason: (result.stderr || result.stdout || `probe exited ${result.status}`).trim(),
    });
    if (result.status === 0) {
      return parsed;
    }
    lastResult = parsed;
    sleep(250);
  }
  return lastResult;
}

function parseProbeOutput(stdout, fallback) {
  const trimmed = String(stdout ?? "").trim();
  if (trimmed) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through to fallback
    }
  }
  return {
    label: fallback.label,
    url: fallback.url,
    passed: false,
    expectedText: fallback.expectedText,
    expectedJsonFields: fallback.expectedJsonFields,
    reason: fallback.fallbackReason || "Probe did not produce structured output.",
  };
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function renderProductReadinessMarkdown(readiness) {
  const lines = [
    "# Full Product Readiness",
    "",
    `Generated: ${readiness.generatedAt}`,
    `Product: ${readiness.productName}`,
    `Passed: ${readiness.passed ? "yes" : "no"}`,
    `Manual URL: ${readiness.commands.manualUrl}`,
    "",
    "## Commands",
    "",
    `- Install: ${readiness.commands.install}`,
    `- Test: ${readiness.commands.test}`,
    `- Start: ${readiness.commands.start}`,
    "",
    "## Checks",
    "",
    "| Check | Result | Severity | Detail |",
    "| --- | --- | --- | --- |",
  ];
  for (const check of readiness.checks) {
    lines.push(
      `| ${escapeMarkdownTableCell(check.label)} | ${check.passed ? "passed" : "failed"} | ${escapeMarkdownTableCell(
        check.severity,
      )} | ${escapeMarkdownTableCell(check.message)} |`,
    );
  }
  lines.push("", "## Blockers", "");
  if (readiness.blockers.length === 0) {
    lines.push("None.");
  } else {
    for (const blocker of readiness.blockers) {
      lines.push(`- ${blocker.label}: ${blocker.message}`);
    }
  }
  lines.push("", "## Dashboard Dependency Gate", "");
  lines.push(`Satisfied: ${readiness.dashboardDependencies.satisfied ? "yes" : "no"}`);
  lines.push(`Source: ${readiness.dashboardDependencies.source}`);
  lines.push(`Declared refs: ${readiness.dashboardDependencies.dependsOn.join(", ") || "none"}`);
  lines.push(`Accepted refs: ${readiness.dashboardDependencies.acceptedRefs.join(", ") || "none"}`);
  lines.push(`Missing refs: ${readiness.dashboardDependencies.missingRefs.join(", ") || "none"}`);
  lines.push("", "## Probe Isolation", "");
  lines.push(`Strategy: ${readiness.probeIsolation?.strategy ?? "unknown"}`);
  lines.push(`Isolated: ${readiness.probeIsolation?.isolated ? "yes" : "no"}`);
  lines.push(`Source target: ${readiness.probeIsolation?.sourcePath ?? "unknown"}`);
  lines.push(`Probe workspace: ${readiness.probeIsolation?.workspacePath ?? "none"}`);
  if (readiness.probeIsolation?.reason) lines.push(`Reason: ${readiness.probeIsolation.reason}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function renderProductProbeMarkdown(probe) {
  const lines = [
    "# Invoice Dashboard Product Probe",
    "",
    `Generated: ${probe.generatedAt}`,
    `Manual URL: ${probe.manualUrl}`,
    `Passed: ${probe.passed ? "yes" : "no"}`,
    "",
    "## Probes",
    "",
    "| Probe | Result | Status | Detail |",
    "| --- | --- | --- | --- |",
  ];
  for (const [key, result] of Object.entries(probe.probes)) {
    lines.push(
      `| ${escapeMarkdownTableCell(result.label ?? key)} | ${result.passed ? "passed" : "failed"} | ${escapeMarkdownTableCell(
        result.status ?? "",
      )} | ${escapeMarkdownTableCell(result.reason ?? result.contentType ?? result.url)} |`,
    );
  }
  lines.push("", "## Required API Fields", "");
  const apiProbe = probe.probes.api;
  if (!apiProbe?.expectedJsonFields?.length) {
    lines.push("None.");
  } else {
    for (const field of apiProbe.expectedJsonFields) {
      lines.push(`- ${field}: ${apiProbe.jsonFieldsPresent?.[field] ? "present" : "missing"}`);
    }
  }
  const markPaidProbe = probe.probes.markPaid;
  lines.push("", "## Mark Paid Workflow", "");
  if (!markPaidProbe) {
    lines.push("Not run.");
  } else {
    lines.push(`Passed: ${markPaidProbe.passed ? "yes" : "no"}`);
    lines.push(`Invoice: ${markPaidProbe.candidate?.id ?? "unknown"}`);
    lines.push(`Paid count increased: ${markPaidProbe.paidCountIncreased ? "yes" : "no"}`);
    lines.push(`Overdue count decreased: ${markPaidProbe.overdueCountDecreased ? "yes" : "no"}`);
    if (markPaidProbe.reason) lines.push(`Reason: ${markPaidProbe.reason}`);
  }
  lines.push("", "## Probe Isolation", "");
  lines.push(`CWD: ${probe.cwd ?? "unknown"}`);
  lines.push(`Product target: ${probe.productTarget ?? "unknown"}`);
  lines.push(`Strategy: ${probe.probeIsolation?.strategy ?? "unknown"}`);
  lines.push(`Isolated: ${probe.probeIsolation?.isolated ? "yes" : "no"}`);
  if (probe.probeIsolation?.reason) lines.push(`Reason: ${probe.probeIsolation.reason}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
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
