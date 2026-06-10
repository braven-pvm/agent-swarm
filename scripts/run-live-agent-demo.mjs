#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
if (!["none", "source-mutation", "reviewer-repair", "stale-run"].includes(faultMode)) {
  throw new Error(`Invalid --fault ${faultMode}; expected none, source-mutation, reviewer-repair, or stale-run`);
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
const scenarioEntityId = `scenario:${scenario}`;

assertApprovedWorkspace(workspace);
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

const summary = {
  workspace,
  driver,
  runMode: finalSnapshot.runMode,
  generatedAt: new Date().toISOString(),
  phase: runPhase,
  scenario,
  fault: {
    mode: faultMode,
    injected: injectedFaults,
  },
  finalOutcome,
  finalReason,
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
  runs: {
    overseers: finalSnapshot.agentRuns.filter((run) => run.role === "overseer" && run.entityId === scenarioEntityId),
    workers: workerRuns,
    reviewers: reviewerRuns,
    worker: workerRun,
    reviewer: reviewerRun,
  },
  review: finalSlice?.reviewResult,
  sourceMutations: finalSourceMutations,
  assertions: {
    runModeIsLive: finalSnapshot.runMode === "live-agent-smoke",
    faultInjected: faultMode === "none" || injectedFaults.length > 0,
    faultDetected:
      faultMode === "none" ||
      (faultMode === "source-mutation" && finalSourceMutations.some((item) => item.mutated)) ||
      (faultMode === "reviewer-repair" && finalSnapshot.recentEvents.some((event) => event.type === "review.blocked_acceptance")) ||
      (faultMode === "stale-run" &&
        staleRun?.status === "stale" &&
        finalSnapshot.recentEvents.some((event) => event.type === "recovery.marked_stale_run")),
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
  artifacts: {
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
  },
};

updateManifest({
  phase: runPhase,
  runMode: "live-agent-smoke",
  liveRun: {
    command: "npm run demo:live-agent:run",
    driver,
    summary: summaryPath,
    fault: faultMode,
    finalOutcome,
    finalReason,
    updatedAt: new Date().toISOString(),
  },
});
fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify(summary, null, 2));

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
