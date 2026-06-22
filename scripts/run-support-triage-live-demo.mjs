#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createEvent } from "../dist/events.js";
import { buildHumanActionQueue } from "../dist/human-actions.js";
import { makeId } from "../dist/ids.js";
import { buildCoverage } from "../dist/observability.js";
import { SwarmStore } from "../dist/storage.js";
import { shouldDispatchSkeptic } from "./skeptic-auto-dispatch.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const scenario = args.scenario ?? "live-agent-smoke-h2";
if (scenario !== "live-agent-smoke-h2") {
  throw new Error(`Support triage live demo only supports live-agent-smoke-h2; received ${scenario}.`);
}

const driver = args.driver ?? "codex";
if (driver !== "codex") {
  throw new Error("Support triage live demo exercises the real codex child-agent path; use --driver codex.");
}

const cli = path.join(repoRoot, "dist", "cli.js");
const resetScript = path.join(repoRoot, "scripts", "reset-live-agent-smoke.mjs");
const workspace = path.resolve(args.workspace ?? path.join(repoRoot, ".swarm-demo", "live-agent-smoke-h2"));
const manifestPath = path.join(workspace, "live-agent-smoke.json");
const summaryPath = path.resolve(args.summary ?? path.join(workspace, "support-triage-live-summary.json"));
const artifactDir = path.resolve(args.artifacts ?? path.join(workspace, "support-triage-live-artifacts"));
const readinessPath = path.join(artifactDir, "product-readiness.json");
const readinessMarkdownPath = path.join(artifactDir, "product-readiness.md");
const finalSnapshotPath = path.join(artifactDir, "final-snapshot.json");
const graphPath = path.join(artifactDir, "graph.json");
const coveragePath = path.join(artifactDir, "coverage.json");
const humanActionsPath = path.join(artifactDir, "human-actions.json");
const resetBeforeRun = args.reset === "true" || !fs.existsSync(path.join(workspace, ".swarm", "state.db"));
const maxTurns = positiveInt(args["max-turns"], 96);
const executeLimit = positiveInt(args["execute-limit"], 4);
const maxRuntimeSeconds = positiveInt(args["max-runtime-seconds"], 9000);
const maxSlices = positiveInt(args["max-slices"], 24);
const maxAgentRuns = positiveInt(args["max-agent-runs"], 180);
const maxRepairAttempts = positiveInt(args["max-repair-attempts"], 8);
const mode = args.mode ?? "full-product";
const runStartedAt = new Date().toISOString();
const runId = safeRunId(args["run-id"] ?? `H2-${compactTimestamp(runStartedAt)}-${process.pid}`);

assertApprovedWorkspace(workspace);
if (!fs.existsSync(cli)) throw new Error(`Built CLI not found: ${cli}. Run npm run build first.`);
if (resetBeforeRun) {
  execFileSync(process.execPath, [resetScript, "--scenario", scenario, "--workspace", workspace, "--stop-related-processes"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 50 * 1024 * 1024,
  });
}

fs.mkdirSync(artifactDir, { recursive: true });
runSwarm(["run-mode", "set", "live-agent-smoke"]);
updateManifest({
  phase: "phase-11d-h2-real-agent-run",
  runMode: "live-agent-smoke",
  mode,
  runnerStatus: "real_agent_run_active",
  liveRun: {
    runId,
    startedAt: runStartedAt,
    summaryPath,
    artifactsPath: artifactDir,
    driver,
  },
});

const startedAt = Date.now();
const turns = [];
const verifyRuns = [];
const autoSkepticRuns = [];
let finalOutcome;
let finalReason;
let productReadiness;
let finalCoverageGate;

for (let turn = 1; turn <= maxTurns; turn += 1) {
  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  if (elapsedSeconds > maxRuntimeSeconds) {
    finalOutcome = "blocked";
    finalReason = `Max runtime exceeded: ${elapsedSeconds}s > ${maxRuntimeSeconds}s.`;
    break;
  }

  const before = observe(220);
  const sourceMutations = inspectSourceMutations(before.sources);
  if (sourceMutations.some((source) => source.mutated)) {
    finalOutcome = "human_required";
    finalReason = "Immutable source mutation detected during H2 live run.";
    turns.push({ turn, kind: "source-mutation", sourceMutations });
    break;
  }
  if (before.slices.length > maxSlices) {
    finalOutcome = "blocked";
    finalReason = `Max slices exceeded: ${before.slices.length} > ${maxSlices}.`;
    break;
  }
  if (before.agentRuns.length > maxAgentRuns) {
    finalOutcome = "blocked";
    finalReason = `Max agent runs exceeded: ${before.agentRuns.length} > ${maxAgentRuns}.`;
    break;
  }

  const retryBudget = inspectRepairRetryBudget(before);
  if (retryBudget.exhausted) {
    recordRepairRetryBudgetExhausted(retryBudget);
    finalOutcome = "blocked";
    finalReason = retryBudget.reason;
    turns.push({ turn, kind: "repair-retry-budget-exhausted", ...retryBudget });
    break;
  }

  const humanActions = humanActionSummary();
  const reworkHumanActions = humanVerificationReworkActions(humanActions);
  if (reworkHumanActions.length > 0) {
    turns.push({
      turn,
      kind: "human-verification-rework-visible",
      totals: humanActions.totals,
      actions: reworkHumanActions.map(summarizeHumanAction),
      reason: "Human verification failed with actionable feedback; continue the autonomous repair loop instead of stopping for another human decision.",
    });
  }
  const terminalHumanActions = terminalHumanInterventionActions(humanActions);
  if (terminalHumanActions.length > 0) {
    finalOutcome = "human_required";
    finalReason = `Human intervention queue contains ${terminalHumanActions.length} decision or verification item(s).`;
    turns.push({
      turn,
      kind: "human-required",
      totals: humanActions.totals,
      actions: terminalHumanActions.map(summarizeHumanAction),
    });
    break;
  }

  const targetedRepair = findTargetedRepairDispatch(before);
  if (targetedRepair) {
    recordTargetedRepairDispatch(targetedRepair);
    const output = runSwarm(["run", targetedRepair.sliceId, "--actor", targetedRepair.actor, "--driver", driver]);
    const outputPath = path.join(artifactDir, `turn-${turn}-targeted-repair-output.txt`);
    fs.writeFileSync(outputPath, output, "utf8");
    turns.push({
      turn,
      kind: "targeted-repair-dispatch",
      outputPath,
      ...targetedRepair,
    });
    continue;
  }

  const readyForVerify = before.slices.find(isReadyForDeterministicVerify);
  if (readyForVerify) {
    // LAZY AUTO-SKEPTIC (RE-1 dispatch / RE-2 gate unchanged): dispatch an INDEPENDENT skeptic via the run's
    // driver before verify when the accepted review still carries a downgradable BLOCKING quality concern and
    // has not been challenged yet. Actor `h2-skeptic-${turn}` is distinct from every H2 worker/reviewer/
    // verifier name; the CLI independence guard is the backstop.
    const skepticDecision = shouldDispatchSkeptic(readyForVerify);
    if (skepticDecision.dispatch) {
      const skepticActor = `h2-skeptic-${turn}`;
      const skepticTurn = {
        turn,
        kind: "auto-skeptic",
        sliceId: readyForVerify.id,
        actor: skepticActor,
        driver,
        reasons: skepticDecision.reasons,
      };
      try {
        const skepticOutput = runSwarm(["skeptic", readyForVerify.id, "--actor", skepticActor, "--driver", driver]);
        const skepticOutputPath = path.join(artifactDir, `turn-${turn}-skeptic-output.txt`);
        fs.writeFileSync(skepticOutputPath, skepticOutput, "utf8");
        skepticTurn.outputPath = skepticOutputPath;
        skepticTurn.dispatched = true;
      } catch (error) {
        skepticTurn.dispatched = false;
        skepticTurn.error = error?.stderr?.toString?.() || error?.message || String(error);
      }
      autoSkepticRuns.push(skepticTurn);
      turns.push(skepticTurn);
    }

    const output = runSwarm(["verify", readyForVerify.id, "--actor", `h2-deterministic-verifier-${turn}`, "--force"]);
    const outputPath = path.join(artifactDir, `turn-${turn}-verify-output.txt`);
    fs.writeFileSync(outputPath, output, "utf8");
    const afterVerify = observe(260);
    const verifiedSlice = afterVerify.slices.find((slice) => slice.id === readyForVerify.id);
    const verifyTurn = {
      turn,
      kind: "verify",
      sliceId: readyForVerify.id,
      outputPath,
      statusAfter: verifiedSlice?.status,
      accepted: verifiedSlice?.status === "accepted",
    };
    verifyRuns.push(verifyTurn);
    turns.push(verifyTurn);

    const afterHumanActions = humanActionSummary();
    const terminalAfterVerify = terminalHumanInterventionActions(afterHumanActions);
    if (terminalAfterVerify.length > 0) {
      finalOutcome = "human_required";
      finalReason = `Verification surfaced ${terminalAfterVerify.length} human intervention item(s).`;
      turns.push({
        turn,
        kind: "human-required-after-verify",
        totals: afterHumanActions.totals,
        actions: terminalAfterVerify.map(summarizeHumanAction),
      });
      break;
    }

    productReadiness = await inspectProductReadiness({ runCommands: true });
    if (productReadiness.passed) {
      const coverageDecision = recordH2CoverageGate({ turn, sliceId: readyForVerify.id, snapshot: afterVerify });
      if (coverageDecision.terminal) break;
      if (coverageDecision.continue) continue;
    }
    continue;
  }

  const output = runSwarm([
    "orchestrate",
    "--actor",
    "h2-live-overseer",
    "--driver",
    driver,
    "--scenario",
    scenario,
    "--execute",
    "--execute-limit",
    String(executeLimit),
  ]);
  const outputPath = path.join(artifactDir, `turn-${turn}-overseer-output.txt`);
  fs.writeFileSync(outputPath, output, "utf8");
  const after = observe(260);
  const latestOverseerRun = after.agentRuns.filter((run) => run.role === "overseer" && run.entityId === `scenario:${scenario}`).at(-1);
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

  const afterHumanActions = humanActionSummary();
  const terminalAfterOverseer = terminalHumanInterventionActions(afterHumanActions);
  if (terminalAfterOverseer.length > 0) {
    finalOutcome = "human_required";
    finalReason = `Overseer turn surfaced ${terminalAfterOverseer.length} human intervention item(s).`;
    break;
  }
  const commandSummary = latestCommands?.payload;
  if (commandSummary && commandSummary.executed === 0 && (commandSummary.blocked > 0 || commandSummary.failed > 0)) {
    finalOutcome = "blocked";
    finalReason = "Overseer command execution made no progress and reported blocked/failed commands.";
    break;
  }
}

productReadiness = productReadiness ?? (await inspectProductReadiness({ runCommands: true }));
const finalSnapshot = observe(280);
const coverage = withStore((store) => buildCoverage(store));
const humanActions = humanActionSummary();
const graph = JSON.parse(runSwarm(["graph", "--format", "json"]));

if (!finalOutcome) {
  const terminalHumanActions = terminalHumanInterventionActions(humanActions);
  if (terminalHumanActions.length > 0) {
    finalOutcome = "human_required";
    finalReason = `Human intervention queue contains ${terminalHumanActions.length} decision or verification item(s).`;
  } else if (humanActions.totals.blockers > 0) {
    finalOutcome = "blocked";
    finalReason = `Active blocker queue contains ${humanActions.totals.blockers} repair or clearance item(s).`;
  } else if (productReadiness.passed) {
    finalCoverageGate = inspectH2CoverageGate();
    if (finalCoverageGate.passed) {
      finalOutcome = "accepted";
      finalReason = "H2 product readiness passed and requirement coverage is complete.";
    } else {
      finalOutcome = "blocked";
      finalReason = finalCoverageGate.reason;
    }
  } else {
    finalOutcome = "blocked";
    finalReason = `Max turns reached without complete product acceptance: ${maxTurns}.`;
  }
}

fs.writeFileSync(finalSnapshotPath, `${JSON.stringify(finalSnapshot, null, 2)}\n`, "utf8");
fs.writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
fs.writeFileSync(coveragePath, `${JSON.stringify(coverage, null, 2)}\n`, "utf8");
fs.writeFileSync(humanActionsPath, `${JSON.stringify(humanActions, null, 2)}\n`, "utf8");
fs.writeFileSync(readinessPath, `${JSON.stringify(productReadiness, null, 2)}\n`, "utf8");
fs.writeFileSync(readinessMarkdownPath, renderProductReadinessMarkdown(productReadiness), "utf8");

const summary = {
  runId,
  scenario,
  workspace,
  phase: "phase-11d-h2-real-agent-run",
  mode,
  driver,
  startedAt: runStartedAt,
  generatedAt: new Date().toISOString(),
  finalOutcome,
  finalReason,
  limits: {
    maxTurns,
    executeLimit,
    maxRuntimeSeconds,
    maxSlices,
    maxAgentRuns,
    maxRepairAttempts,
  },
  turns,
  verifyRuns,
  autoSkepticRuns,
  coverage: {
    done: coverage.totals.done,
    total: coverage.totals.total,
    percentage: coverage.interpretation.completionPercent,
    state: coverage.interpretation.state,
    awaitingHumanVerification: coverage.ledger.totals.awaiting_human_verification ?? 0,
    humanVerified: coverage.ledger.totals.human_verified ?? 0,
  },
  humanActions: humanActions.totals,
  productReadiness: {
    passed: productReadiness.passed,
    blockers: productReadiness.blockers,
    manualUrl: productReadiness.commands.manualUrl,
  },
  finalCoverageGate,
  counts: {
    turns: turns.length,
    verifyRuns: verifyRuns.length,
    slices: finalSnapshot.slices.length,
    acceptedSlices: finalSnapshot.slices.filter((slice) => slice.status === "accepted").length,
    agentRuns: finalSnapshot.agentRuns.length,
    activeEscalations: finalSnapshot.activeEscalations.length,
    graphNodes: graph.nodes.length,
    graphEdges: graph.edges.length,
  },
  artifacts: {
    summary: summaryPath,
    finalSnapshot: finalSnapshotPath,
    graph: graphPath,
    coverage: coveragePath,
    humanActions: humanActionsPath,
    productReadiness: readinessPath,
    productReadinessMarkdown: readinessMarkdownPath,
  },
  assertions: {
    realRunnerWired: true,
    scenarioManifestLoaded: fs.existsSync(manifestPath),
    usedCodexDriver: driver === "codex",
    wroteCoverageArtifact: fs.existsSync(coveragePath),
    wroteHumanActionsArtifact: fs.existsSync(humanActionsPath),
    wroteProductReadinessArtifact: fs.existsSync(readinessPath),
  },
};

fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
updateManifest({
  phase: "phase-11d-h2-real-agent-run",
  runnerStatus: `real_agent_run_${finalOutcome}`,
  liveRun: {
    runId,
    startedAt: runStartedAt,
    generatedAt: summary.generatedAt,
    summaryPath,
    artifactsPath: artifactDir,
    finalOutcome,
    finalReason,
    coverage: summary.coverage,
    productReadiness: summary.productReadiness,
    finalCoverageGate,
  },
});

console.log(JSON.stringify(summary, null, 2));

function isReadyForDeterministicVerify(slice) {
  if (slice.status !== "ready_for_review") return false;
  if (slice.reviewResult?.status !== "accepted") return false;
  return !slice.evidence.some((item) => item.kind === "command" && item.payload?.passed === true);
}

function coverageIsComplete() {
  const current = withStore((store) => buildCoverage(store));
  return current.totals.total > 0 && current.totals.done === current.totals.total;
}

function recordH2CoverageGate({ turn, sliceId, snapshot }) {
  finalCoverageGate = inspectH2CoverageGate();
  turns.push({
    turn,
    kind: "h2-full-product-coverage-gate",
    sliceId,
    passed: finalCoverageGate.passed,
    totals: finalCoverageGate.totals,
    incompleteCount: finalCoverageGate.incompleteCount,
    sampleIncompleteRefs: finalCoverageGate.sampleIncompleteRefs,
    topIncompleteDomains: finalCoverageGate.topIncompleteDomains,
  });
  if (finalCoverageGate.passed) {
    finalOutcome = "accepted";
    finalReason = "H2 product readiness passed and requirement coverage is complete.";
    return { terminal: true, continue: false };
  }

  const completionWork = ensureH2CoverageCompletionWork({ coverageGate: finalCoverageGate, snapshot, turn });
  if (completionWork) {
    turns.push(completionWork);
    return { terminal: false, continue: true };
  }

  finalOutcome = "blocked";
  finalReason = finalCoverageGate.reason;
  return { terminal: true, continue: false };
}

function inspectH2CoverageGate() {
  const coverage = withStore((store) => buildCoverage(store));
  const incompleteRefs = coverage.refs.filter((ref) => ref.status !== "done");
  const passed = coverage.interpretation?.state === "complete";
  const coverageText = `${coverage.totals.done}/${coverage.totals.total}`;
  return {
    passed,
    generatedAt: coverage.generatedAt,
    state: coverage.interpretation?.state ?? "empty",
    totals: coverage.totals,
    incompleteCount: incompleteRefs.length,
    sampleIncompleteRefs: incompleteRefs.slice(0, 12).map((ref) => ({
      ref: ref.ref,
      domain: ref.domain,
      status: ref.status,
      nextAction: ref.nextAction,
      ledgerStatus: ref.ledgerStatus,
      statusReason: ref.statusReason,
    })),
    topIncompleteDomains: (coverage.interpretation?.topIncompleteDomains ?? []).slice(0, 5).map((domain) => ({
      domain: domain.domain,
      total: domain.total,
      done: domain.done,
      incomplete: domain.incomplete,
      completionPercent: domain.completionPercent,
    })),
    reason: passed
      ? "Indexed FR/AC coverage is complete."
      : `H2 product readiness passed, but final acceptance is blocked because indexed FR/AC coverage is partial (${coverageText}).`,
  };
}

function ensureH2CoverageCompletionWork({ coverageGate, snapshot, turn }) {
  if (!coverageGate || coverageGate.passed) return undefined;

  const activeSlice = snapshot?.slices?.find((slice) => isActiveSlice(slice));
  if (activeSlice) {
    return {
      turn,
      kind: "coverage-completion-work-visible",
      sliceId: activeSlice.id,
      status: activeSlice.status,
      refs: activeSlice.frAcRefs,
      reason: "Indexed coverage is incomplete, but an active slice is already visible for the overseer loop.",
    };
  }

  const coverage = withStore((store) => buildCoverage(store));
  const incompleteRefs = coverage.refs.filter((ref) => ref.status !== "done");
  const store = new SwarmStore(workspace);
  try {
    const activeStoredSlice = store.listSlices().find((slice) => isActiveSlice(slice));
    if (activeStoredSlice) {
      return {
        turn,
        kind: "coverage-completion-work-visible",
        sliceId: activeStoredSlice.id,
        status: activeStoredSlice.status,
        refs: activeStoredSlice.frAcRefs,
        reason: "Indexed coverage is incomplete, but an active stored slice is already available.",
      };
    }

    const completionGroup = selectH2CoverageCompletionGroup(store, incompleteRefs);
    if (!completionGroup) return undefined;

    const target = findH2CoverageCompletionTarget(store, completionGroup.source);
    if (!target) return undefined;

    const now = new Date().toISOString();
    let lane = store.firstActiveLaneForTarget(target.id);
    let laneCreated = false;
    if (!lane) {
      lane = {
        id: makeId("lane"),
        name: h2CoverageCompletionLaneName(completionGroup),
        purpose: `Complete ${completionGroup.label} coverage from ${completionGroup.source.title}.`,
        focusLabels: h2CoverageCompletionLaneLabels(completionGroup),
        targetId: target.id,
        orchestrator: "h2-live-overseer",
        worktree: target.path,
        state: "active",
        createdAt: now,
        updatedAt: now,
      };
      store.insertLane(lane);
      laneCreated = true;
      store.addEvent(
        createEvent({
          actor: "h2-coverage-loop",
          type: "lane.created",
          entityType: "lane",
          entityId: lane.id,
          payload: {
            reason: "H2 coverage gate found unowned refs and needed a visible completion lane.",
            sourceId: completionGroup.source.id,
            targetId: target.id,
            purpose: lane.purpose,
          },
        }),
      );
    }

    const sourceText = fs.existsSync(completionGroup.source.uri)
      ? fs.readFileSync(completionGroup.source.uri, "utf8")
      : "";
    const obligations = buildH2CoverageCompletionObligations({
      source: completionGroup.source,
      sourceText,
      refs: completionGroup.refs,
      now,
    });
    const expectedEvidence = obligations
      .map((obligation) => obligation.criteria[0]?.expectedOutcome ?? `Behavior evidence proving ${obligation.ref}.`)
      .concat(h2CoverageCompletionExpectedEvidence(completionGroup));
    const sourceRef = {
      adapterId: completionGroup.source.adapterId,
      kind: completionGroup.source.kind,
      uri: completionGroup.source.uri,
      title: completionGroup.source.title,
      hash: completionGroup.source.hash,
    };
    const slice = {
      id: makeId("slice"),
      laneId: lane.id,
      targetId: target.id,
      title: `Complete ${completionGroup.label} coverage (${completionGroup.refs.join(", ")})`,
      status: "ready",
      sourceRefs: [sourceRef],
      frAcRefs: completionGroup.refs,
      deliveryQuestion: `Can the ${completionGroup.label} refs be implemented or proven against immutable source criteria?`,
      workPackageType: h2CoverageCompletionWorkPackageType(completionGroup),
      minimumMeaningfulOutcome: h2CoverageCompletionMinimumOutcome(completionGroup),
      acSizedExceptionReason: completionGroup.refs.length === 1
        ? "Single remaining ref is allowed because coverage completion must close each immutable FR/AC explicitly."
        : undefined,
      scope: completionGroup.refs.map((ref) => `Implement or prove the behavior required by ${ref}.`),
      outOfScope: [
        "Do not mutate source specs.",
        "Do not mark refs complete without worker evidence, independent review, and deterministic verification or human sign-off.",
        "Do not weaken or replace previously accepted behavior to satisfy coverage.",
      ],
      expectedEvidence,
      verificationObligations: obligations,
      unblockTargets: ["h2-full-product-coverage-gate", "final-product-acceptance"],
      verificationRequirements: [
        "Map evidence to every included FR/AC ref.",
        "Run the target test command if configured.",
        "For UI/design refs, prove rendered/user-facing behavior and token/accessibility constraints where applicable.",
        "For human-verification refs, produce the human verification packet and keep final acceptance pending until sign-off.",
        "Reviewer and deterministic verifier must pass every included automated ref before acceptance.",
      ],
      createdAt: now,
      updatedAt: now,
    };
    store.insertSlice(slice);

    const leases = completionGroup.refs.map((frAcRef) => {
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

    store.insertDependency({
      id: makeId("dependency"),
      fromType: "slice",
      fromId: slice.id,
      target: "h2-full-product-coverage-gate",
      reason: "H2 full-product smoke cannot be accepted until every indexed FR/AC ref is verified, human-verified, or explicitly blocked.",
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });

    store.addEvent(
      createEvent({
        actor: "h2-coverage-loop",
        type: "coverage_completion.slice_created",
        entityType: "slice",
        entityId: slice.id,
        payload: {
          reason: coverageGate.reason,
          sourceId: completionGroup.source.id,
          sourceTitle: completionGroup.source.title,
          coveragePackKey: completionGroup.key,
          coveragePackLabel: completionGroup.label,
          targetId: target.id,
          laneId: lane.id,
          laneCreated,
          frAcRefs: completionGroup.refs,
          incompleteBefore: coverageGate.incompleteCount,
        },
      }),
    );
    store.addEvent(
      createEvent({
        actor: "h2-live-overseer",
        type: "decision.recorded",
        entityType: "slice",
        entityId: slice.id,
        payload: {
          decision: "continue_h2_full_product_run_for_coverage_completion",
          reason: "Product readiness passed but indexed FR/AC coverage was incomplete.",
          dependenciesConsidered: ["product readiness", "coverage gate", "immutable source refs"],
          coveragePackKey: completionGroup.key,
          coveragePackLabel: completionGroup.label,
          selectedRefs: completionGroup.refs,
        },
      }),
    );

    return {
      turn,
      kind: "coverage-completion-slice-created",
      sliceId: slice.id,
      laneId: lane.id,
      laneCreated,
      sourceId: completionGroup.source.id,
      sourceTitle: completionGroup.source.title,
      coveragePackKey: completionGroup.key,
      coveragePackLabel: completionGroup.label,
      targetId: target.id,
      refs: completionGroup.refs,
      leases: leases.map((lease) => lease.frAcRef),
      reason: "H2 product readiness passed, but coverage was partial; remaining refs were converted into a visible verification slice.",
    };
  } finally {
    store.close();
  }
}

function selectH2CoverageCompletionGroup(store, incompleteRefs) {
  const sources = store.listSources();
  const groups = new Map();
  for (const coverageRef of incompleteRefs) {
    if (!["not_started", "in_progress"].includes(coverageRef.status)) continue;
    if (!["pull_slice", "run_worker", "run_reviewer", "run_verifier"].includes(coverageRef.nextAction)) continue;
    const lease = store.latestLeaseFor(coverageRef.ref);
    if (lease && lease.status !== "released") continue;
    const source = sources.find((item) => item.id === coverageRef.sourceId);
    if (!source) continue;
    const family = h2RefFamilyKey(coverageRef.ref);
    const key = `${source.id}:${family}`;
    const existing = groups.get(key) ?? {
      source,
      family,
      key: `${h2SourceKey(source)}-${family.toLowerCase()}`,
      label: h2CoverageCompletionLabel(source, family),
      refs: [],
    };
    existing.refs.push(coverageRef.ref);
    groups.set(key, existing);
  }

  return [...groups.values()]
    .map((group) => ({ ...group, refs: h2SortRefs(group.refs).slice(0, 12) }))
    .filter((group) => group.refs.length > 0)
    .sort(
      (left, right) =>
        h2SourceRank(left.source) - h2SourceRank(right.source) ||
        h2FamilyRank(left.family) - h2FamilyRank(right.family) ||
        left.source.createdAt.localeCompare(right.source.createdAt) ||
        left.key.localeCompare(right.key),
    )[0];
}

function findH2CoverageCompletionTarget(store, source) {
  const manifest = readManifest();
  const targets = store.listTargets();
  const descriptor = h2SourceDescriptor(source);
  const manifestTargets = Array.isArray(manifest.targets) ? manifest.targets : [];
  const productTargetName = manifest.product?.target ?? "support-ui";

  if (/\b(api|backend|server)\b/i.test(descriptor)) {
    return findTargetByManifestRole(targets, manifestTargets, "backend") ??
      targets.find((target) => /\b(api|backend|server)\b/i.test(`${target.name} ${target.path}`));
  }
  if (/\b(frontend|ui|dashboard|design|accessibility|product|human)\b/i.test(descriptor)) {
    return targets.find((target) => target.name === productTargetName) ??
      findTargetByManifestRole(targets, manifestTargets, "frontend") ??
      targets.find((target) => /\b(ui|dashboard|web|frontend)\b/i.test(`${target.name} ${target.path}`));
  }
  return targets.find((target) => target.name === productTargetName) ?? targets[0];
}

function findTargetByManifestRole(targets, manifestTargets, role) {
  const manifestTarget = manifestTargets.find((target) => target.role === role);
  if (!manifestTarget) return undefined;
  return targets.find((target) => target.name === manifestTarget.name);
}

function h2CoverageCompletionLaneName(group) {
  return `H2 Coverage Lane: ${group.label}`;
}

function h2CoverageCompletionLaneLabels(group) {
  const tags = h2SourceTags(group.source);
  const base = ["h2", "coverage", h2SourceKey(group.source), group.family.toLowerCase()];
  if (tags.some((tag) => /backend|api/.test(tag))) base.push("backend");
  if (tags.some((tag) => /frontend|ui|design|accessibility/.test(tag))) base.push("frontend");
  return [...new Set(base)];
}

function h2CoverageCompletionWorkPackageType(group) {
  const descriptor = h2SourceDescriptor(group.source);
  if (/\b(api|backend|server)\b/i.test(descriptor)) return "runtime_capability";
  if (/\b(ui|dashboard|frontend|design)\b/i.test(descriptor)) return "component_pack";
  return "proof_pack";
}

function h2CoverageCompletionMinimumOutcome(group) {
  const descriptor = h2SourceDescriptor(group.source);
  if (/\b(api|backend|server|ui|dashboard|frontend)\b/i.test(descriptor)) return "changes_runtime_path";
  return "proves_cutover_or_readiness";
}

function h2CoverageCompletionExpectedEvidence(group) {
  const refs = group.refs.map((ref) => ref.toUpperCase());
  const descriptor = h2SourceDescriptor(group.source);
  const evidence = [];
  if (/\b(api|backend|server)\b/i.test(descriptor) || refs.some((ref) => /^AC-SUP-API|^FR-SUP-API/.test(ref))) {
    evidence.push("Backend/API refs: executable tests or HTTP/in-process probes must prove exact endpoint behavior, filters, sorting, mutation, and error paths where applicable.");
  }
  if (/\b(ui|dashboard|frontend)\b/i.test(descriptor) || refs.some((ref) => /^AC-SUP-UI|^FR-SUP-UI/.test(ref))) {
    evidence.push("UI refs: evidence must prove rendered/user-facing behavior and real API wiring; static markup or function-existence checks alone are insufficient.");
  }
  if (/\bdesign|accessibility\b/i.test(descriptor) || refs.some((ref) => /^AC-DS|^FR-DS/.test(ref))) {
    evidence.push("Design/accessibility refs: evidence must cite token usage, layout behavior, non-color-only states, and responsive constraints.");
  }
  if (refs.some((ref) => /HUMAN/.test(ref))) {
    evidence.push("Human-verification refs: produce a human verification packet with exact criteria, product URL, automated evidence, and pass/fail/needs-rework controls.");
  }
  return evidence;
}

function buildH2CoverageCompletionObligations({ source, sourceText, refs, now }) {
  return refs.map((ref) => {
    const sourceMatch = findSourceTextForRef(sourceText, ref);
    const humanRequired = h2RefRequiresHumanVerification(ref, sourceMatch, source);
    return {
      ref,
      sourceRef: source.id,
      sourceUri: source.uri,
      sourceTitle: source.title,
      sourceText: sourceMatch.text,
      sourceContext: sourceMatch.context,
      mode: humanRequired ? "human_verification_required" : "automated",
      responsibleParty: humanRequired ? "human-qa" : "deterministic-verifier",
      criteria: [
        {
          id: `${ref}.result`,
          expectedOutcome: sourceMatch.text,
          evidenceRequired: humanRequired
            ? ["worker_evidence", "review_result", "human_verification_packet", "human_signoff"]
            : ["worker_evidence", "review_result", "verification_command"],
          acceptanceThreshold: humanRequired
            ? "supporting automated evidence and independent review pass, then human verifies the packet"
            : "worker coverage, review, and deterministic verification all pass",
        },
      ],
      createdBy: "h2-coverage-completion-planner",
      createdAt: now,
      immutable: true,
      guidance: [
        "Do not mutate source specs.",
        "Map worker/reviewer/verifier evidence to this exact FR/AC text.",
        "Completion of this ref requires evidence, not a status-only update.",
        ...h2CoverageCompletionObligationGuidance(ref, sourceMatch, source),
      ],
    };
  });
}

function h2CoverageCompletionObligationGuidance(ref, sourceMatch, source) {
  const normalized = ref.toUpperCase();
  const descriptor = h2SourceDescriptor(source);
  const guidance = [];
  if (/^AC-SUP-API|^FR-SUP-API/.test(normalized) || /\b(api|backend|server)\b/i.test(descriptor)) {
    guidance.push("API/backend refs require exact endpoint or in-process behavior proof, including response shape and mutation effects where applicable.");
  }
  if (/^AC-SUP-UI|^FR-SUP-UI/.test(normalized) || /\b(ui|dashboard|frontend)\b/i.test(descriptor)) {
    guidance.push("UI refs require user-visible state proof and real API wiring, not only static markup or exported function presence.");
  }
  if (/^AC-DS|^FR-DS/.test(normalized) || /\bdesign|accessibility\b/i.test(descriptor)) {
    guidance.push("Design/accessibility refs require token, layout, responsive, and non-color-only state evidence.");
  }
  if (h2RefRequiresHumanVerification(ref, sourceMatch, source)) {
    guidance.push("This ref requires human verification after automated support evidence and independent review are ready.");
  }
  return guidance;
}

function h2RefRequiresHumanVerification(ref, sourceMatch, source) {
  const normalized = ref.toUpperCase();
  const text = `${sourceMatch?.text ?? ""} ${sourceMatch?.context ?? ""} ${h2SourceDescriptor(source)}`;
  return /HUMAN/.test(normalized) || /human[- ]verification|human visual|human can verify|requires human/i.test(text);
}

function h2CoverageCompletionLabel(source, family) {
  return `${h2SourceDomain(source)} ${family}`;
}

function h2RefFamilyKey(ref) {
  const match = /^(?:FR|AC)-(.+?-\d{3})(?:\.\d+)?$/i.exec(ref);
  return (match?.[1] ?? ref).toUpperCase();
}

function h2FamilyRank(family) {
  const match = /(\d{3})$/.exec(family);
  return match ? Number.parseInt(match[1], 10) : 999;
}

function h2SortRefs(refs) {
  return [...refs].sort((left, right) => {
    const leftIsFr = left.startsWith("FR-") ? 0 : 1;
    const rightIsFr = right.startsWith("FR-") ? 0 : 1;
    return leftIsFr - rightIsFr || left.localeCompare(right, undefined, { numeric: true });
  });
}

function h2SourceRank(source) {
  const descriptor = h2SourceDescriptor(source);
  if (/\b(api|backend|server)\b/i.test(descriptor)) return 0;
  if (/\bproduct|full-product|smoke\b/i.test(descriptor)) return 1;
  if (/\b(ui|dashboard|frontend)\b/i.test(descriptor)) return 2;
  if (/\bdesign|accessibility\b/i.test(descriptor)) return 3;
  return 4;
}

function h2SourceKey(source) {
  return h2SourceDomain(source).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "source";
}

function h2SourceDescriptor(source) {
  return [source.title, h2SourceDomain(source), ...h2SourceTags(source), path.basename(source.uri)].join(" ");
}

function h2SourceDomain(source) {
  return typeof source.metadata?.domain === "string" ? source.metadata.domain : "Unassigned";
}

function h2SourceTags(source) {
  const tags = source.metadata?.tags;
  if (Array.isArray(tags)) return tags.map((tag) => String(tag).toLowerCase());
  if (typeof tags === "string") return tags.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean);
  return [];
}

function findSourceTextForRef(sourceText, ref) {
  const lines = sourceText.split(/\r?\n/);
  const normalizedRef = ref.toUpperCase();
  let context;
  for (const line of lines) {
    const trimmed = line.trim();
    const heading = /^#{1,6}\s+(.+)$/.exec(trimmed);
    if (heading) context = heading[1].trim();
    if (trimmed.toUpperCase().includes(normalizedRef)) {
      return {
        text: trimmed.replace(/^[-*]\s*/, ""),
        context,
      };
    }
  }
  return { text: `Behavior required by ${ref}.`, context };
}

function isActiveSlice(slice) {
  return !["accepted", "closed"].includes(slice.status);
}

function inspectRepairRetryBudget(snapshot) {
  return withStore((store) => {
    const activeSlices = store.listSlices().filter((slice) => isActiveSlice(slice));
    for (const slice of activeSlices) {
      const repairContext = buildH2RepairContext(store, slice);
      if (!repairContext.hasRepairContext) continue;
      const runs = store.listAgentRuns().filter((run) => run.sliceId === slice.id && (run.role === "worker" || run.role === "reviewer"));
      const retryCount = maxAttempt(runs);
      if (retryCount < maxRepairAttempts) continue;
      const latestRun = latestAgentRun(runs);
      const reason = `Repair retry budget exhausted for ${slice.id}: retryCount ${retryCount} >= ${maxRepairAttempts}. Latest ${latestRun?.role ?? "agent"} run ${latestRun?.id ?? "unknown"} is ${latestRun?.status ?? "unknown"}.`;
      return {
        exhausted: true,
        sliceId: slice.id,
        title: slice.title,
        status: slice.status,
        retryCount,
        maxRepairAttempts,
        latestRun: latestRun
          ? { id: latestRun.id, role: latestRun.role, actor: latestRun.actor, status: latestRun.status, attempt: latestRun.attempt }
          : undefined,
        repairContext,
        reason,
      };
    }
    return { exhausted: false };
  });
}

function findTargetedRepairDispatch(snapshot) {
  return withStore((store) => {
    const targetById = new Map(snapshot.targets.map((target) => [target.id, target]));
    for (const slice of store.listSlices().filter((item) => ["repairing", "blocked"].includes(item.status))) {
      const runs = store.listAgentRuns().filter((run) => run.sliceId === slice.id && (run.role === "worker" || run.role === "reviewer"));
      if (runs.some((run) => run.status === "running")) continue;
      const retryCount = maxAttempt(runs);
      if (retryCount >= maxRepairAttempts) continue;
      const repairContext = buildH2RepairContext(store, slice);
      if (!repairContext.hasRepairContext) continue;
      const latestRepairTime = Date.parse(repairContext.latestRepairAt ?? "");
      if (!Number.isFinite(latestRepairTime)) continue;
      const latestWorkerAfterRepair = runs
        .filter((run) => run.role === "worker" && Date.parse(run.startedAt) > latestRepairTime)
        .sort(compareAgentRunTime)
        .at(-1);
      if (latestWorkerAfterRepair) continue;
      const latestRun = latestAgentRun(runs);
      if (latestRun?.role === "worker" && latestRun.status === "completed") continue;
      const target = targetById.get(slice.targetId);
      const actor = h2WorkerActorForTarget(target, slice);
      return {
        sliceId: slice.id,
        actor,
        status: slice.status,
        retryCount,
        maxRepairAttempts,
        latestRepairAt: repairContext.latestRepairAt,
        latestRun: latestRun
          ? { id: latestRun.id, role: latestRun.role, actor: latestRun.actor, status: latestRun.status, attempt: latestRun.attempt }
          : undefined,
        repairContext,
        reason: "Concrete review or human repair context exists and no worker has run after the latest repair signal.",
      };
    }
    return undefined;
  });
}

function buildH2RepairContext(store, slice) {
  const reviewEvidence = store
    .listEvidence(slice.id)
    .filter((item) => item.kind === "review_result" && item.payload?.reviewResult)
    .at(-1);
  const review = reviewEvidence?.payload?.reviewResult;
  const reviewNeedsRepair = review && review.status !== "accepted";
  const humanFeedback = store
    .listEvidence(slice.id)
    .filter((item) => item.kind === "artifact" && item.payload?.type === "human_verification_result")
    .filter((item) => item.payload.status === "failed" || item.payload.status === "needs_rework")
    .slice(-8)
    .map((item) => ({
      evidenceId: item.id,
      ref: item.ref,
      status: item.payload.status,
      actor: item.payload.actor,
      notes: item.payload.notes,
      packetId: item.payload.packetId,
      createdAt: item.createdAt,
    }));
  const requiredFixes = Array.isArray(review?.requiredFixes) ? review.requiredFixes.filter(Boolean) : [];
  const repairTimes = [
    reviewNeedsRepair ? reviewEvidence?.createdAt : undefined,
    ...humanFeedback.map((item) => item.createdAt),
  ].filter(Boolean);
  const latestRepairAt = repairTimes.sort().at(-1);
  return {
    hasRepairContext: Boolean(reviewNeedsRepair || humanFeedback.length > 0),
    latestRepairAt,
    review: reviewNeedsRepair
      ? {
          evidenceId: reviewEvidence.id,
          status: review.status,
          summary: review.summary,
          recommendation: review.recommendation,
          requiredFixes,
          createdAt: reviewEvidence.createdAt,
        }
      : undefined,
    humanFeedback,
  };
}

function recordTargetedRepairDispatch(dispatch) {
  withStore((store) => {
    store.addEvent(
      createEvent({
        actor: "h2-live-runner",
        type: "repair.targeted_dispatch",
        entityType: "slice",
        entityId: dispatch.sliceId,
        payload: dispatch,
      }),
    );
  });
}

function recordRepairRetryBudgetExhausted(result) {
  withStore((store) => {
    const slice = store.listSlices().find((item) => item.id === result.sliceId);
    if (slice) {
      store.updateSliceStatus(slice.id, "blocked");
      store.updateDependenciesFor("slice", slice.id, "blocked");
    }
    const active = store
      .listEscalations("active")
      .some((item) => item.entityType === "slice" && item.entityId === result.sliceId && item.message === "Repair retry budget exhausted.");
    if (!active) {
      const now = new Date().toISOString();
      store.insertEscalation({
        id: makeId("escalation"),
        level: "blocker",
        status: "active",
        entityType: "slice",
        entityId: result.sliceId,
        message: "Repair retry budget exhausted.",
        reason: result.reason,
        createdBy: "h2-live-runner",
        createdAt: now,
        updatedAt: now,
      });
    }
    store.addEvent(
      createEvent({
        actor: "h2-live-runner",
        type: "repair.retry_budget_exhausted",
        entityType: "slice",
        entityId: result.sliceId,
        payload: result,
      }),
    );
  });
}

function h2WorkerActorForTarget(target, slice) {
  const haystack = [target?.name, target?.path, slice.title, ...slice.frAcRefs].filter(Boolean).join(" ").toLowerCase();
  return /dashboard|ui|frontend|design|web/.test(haystack) ? "dashboard-worker" : "backend-worker";
}

function maxAttempt(runs) {
  return runs.reduce((highest, run) => Math.max(highest, run.attempt ?? 1), runs.length);
}

function latestAgentRun(runs) {
  return [...runs].sort(compareAgentRunTime).at(-1);
}

function compareAgentRunTime(left, right) {
  return Date.parse(left.updatedAt ?? left.startedAt) - Date.parse(right.updatedAt ?? right.startedAt);
}

function summarizeHumanAction(action) {
  return {
    id: action.id,
    kind: action.kind,
    severity: action.severity,
    title: action.title,
    status: action.status,
    sliceId: action.sliceId,
    ref: action.ref,
  };
}

async function inspectProductReadiness({ runCommands }) {
  const manifest = readManifest();
  const snapshot = observe(120);
  const config = normalizeProductProbeConfig(manifest.fullProductMode?.productReadinessProbe);
  const productTarget = findProductTarget(manifest, snapshot);
  const productTargetPath = productTarget?.path ?? path.join(workspace, "support-ui");
  const productSpecPath = manifest.productSpec ? path.resolve(manifest.productSpec) : path.join(workspace, "source-specs", "live-smoke-support-triage-product-spec.md");
  const productSource = snapshot.sources.find((source) => samePath(source.uri, productSpecPath));
  const productSourceMutation = productSource ? inspectSourceMutations([productSource])[0] : undefined;
  const packagePath = path.join(productTargetPath, "package.json");
  const packageJson = readJsonFile(packagePath);
  const scripts = packageJson && typeof packageJson === "object" && packageJson.scripts ? packageJson.scripts : {};
  const hasTestScript = typeof scripts.test === "string" && scripts.test.trim().length > 0;
  const hasStartScript = typeof scripts.start === "string" && scripts.start.trim().length > 0;
  const acceptedProductSlices = snapshot.slices.filter((slice) => slice.status === "accepted" && slice.targetId === productTarget?.id);
  const probeIsolation = runCommands && (hasTestScript || hasStartScript)
    ? createProductProbeWorkspace(productTargetPath)
    : {
        strategy: runCommands ? "not-needed" : "commands-disabled",
        sourcePath: productTargetPath,
        workspacePath: undefined,
        copied: false,
        isolated: false,
        reason: runCommands ? "No product readiness commands were available to isolate." : "Command execution disabled for this readiness pass.",
      };
  const commandWorkspace = probeIsolation.workspacePath ?? productTargetPath;
  const probeIsolationFailed = runCommands && (hasTestScript || hasStartScript) && !probeIsolation.workspacePath;
  const testResult = runCommands && hasTestScript && !probeIsolationFailed
    ? runNpmScript("test", path.join(artifactDir, "product-test-output.txt"), { cwd: commandWorkspace })
    : {
        command: "npm test",
        attempted: false,
        passed: false,
        outputPath: hasTestScript ? path.join(artifactDir, "product-test-output.txt") : undefined,
        cwd: hasTestScript ? commandWorkspace : undefined,
        reason: probeIsolationFailed
          ? probeIsolation.reason
          : hasTestScript
            ? "Command execution disabled for this readiness pass."
            : "No npm test script is defined.",
      };
  const manualPort = runCommands && hasStartScript ? await allocateLocalProbePort() : 4321;
  const manualUrl = `http://127.0.0.1:${manualPort}`;
  const startResult = runCommands && hasStartScript && !probeIsolationFailed
    ? await runStartProbe(manualUrl, {
        cwd: commandWorkspace,
        outputPath: path.join(artifactDir, "product-start-output.txt"),
        probeOutputPath: path.join(artifactDir, "product-probe.json"),
        probeMarkdownPath: path.join(artifactDir, "product-probe.md"),
        config,
        probeIsolation,
      })
    : {
        command: "npm start",
        attempted: false,
        passed: false,
        manualUrl,
        outputPath: hasStartScript ? path.join(artifactDir, "product-start-output.txt") : undefined,
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
      passed: fs.existsSync(productSpecPath),
      severity: "blocker",
      message: `Expected copied product spec at ${productSpecPath}.`,
    },
    {
      id: "product-spec-registered",
      label: "Product spec is registered as immutable source",
      passed: Boolean(productSource),
      severity: "blocker",
      message: "The support triage product spec must be registered as a source before full-product work starts.",
    },
    {
      id: "product-spec-unchanged",
      label: "Product spec hash is unchanged",
      passed: Boolean(productSourceMutation && !productSourceMutation.mutated),
      severity: "blocker",
      message: productSourceMutation?.reason ?? "The product spec source hash could not be checked.",
    },
    {
      id: "product-target-exists",
      label: "Support product target exists",
      passed: Boolean(productTarget && fs.existsSync(productTargetPath)),
      severity: "blocker",
      message: `Expected support product target at ${productTargetPath}.`,
    },
    {
      id: "product-package-json",
      label: "Support product package.json exists",
      passed: Boolean(packageJson),
      severity: "blocker",
      message: `Expected package.json at ${packagePath}.`,
    },
    {
      id: "product-test-script",
      label: "Support product has npm test",
      passed: hasTestScript,
      severity: "blocker",
      message: "The final product must expose npm test.",
    },
    {
      id: "product-test-passes",
      label: "Support product npm test passes",
      passed: Boolean(testResult.passed),
      severity: "blocker",
      message: testResult.reason ?? "npm test must pass for the final product target.",
    },
    {
      id: "product-start-script",
      label: "Support product has npm start",
      passed: hasStartScript,
      severity: "blocker",
      message: "The final product must expose npm start so a human can open the triage board.",
    },
    {
      id: "product-start-probed",
      label: "Support product local URL is probed",
      passed: Boolean(startResult.passed),
      severity: "blocker",
      message: startResult.reason ?? "The product must start locally and respond to browser/API/workflow probes.",
    },
    {
      id: "product-target-accepted-slice",
      label: "Support product target has accepted implementation work",
      passed: acceptedProductSlices.length > 0,
      severity: "warning",
      message: "At least one support product target slice should pass worker, reviewer, and deterministic verification before final product acceptance.",
    },
  ];
  const blockers = checks
    .filter((check) => !check.passed && check.severity === "blocker")
    .map((check) => ({ id: check.id, label: check.label, message: check.message }));
  return {
    mode: "full-product",
    generatedAt: new Date().toISOString(),
    productName: "Customer Support Triage Board",
    passed: blockers.length === 0,
    productSpec: {
      workspacePath: productSpecPath,
      exists: fs.existsSync(productSpecPath),
      registered: Boolean(productSource),
      sourceId: productSource?.id,
      hash: productSource?.hash,
      unchanged: Boolean(productSourceMutation && !productSourceMutation.mutated),
      mutation: productSourceMutation,
    },
    target: {
      name: productTarget?.name ?? "support-ui",
      path: productTargetPath,
      exists: fs.existsSync(productTargetPath),
      packageJson: packagePath,
      packageExists: Boolean(packageJson),
      scripts,
    },
    acceptedProductSlices: acceptedProductSlices.map((slice) => ({ id: slice.id, refs: slice.frAcRefs })),
    commands: {
      test: "npm test",
      start: "npm start",
      manualUrl: startResult.manualUrl ?? manualUrl,
      assignedManualUrl: startResult.assignedManualUrl ?? manualUrl,
    },
    probeIsolation,
    productProbeConfig: config,
    commandResults: {
      test: testResult,
      start: startResult,
    },
    checks,
    blockers,
  };
}

function findProductTarget(manifest, snapshot) {
  const productTargetName = manifest.product?.target ?? "support-ui";
  return snapshot.targets.find((target) => target.name === productTargetName) ?? snapshot.targets.find((target) => target.name === "support-ui");
}

function createProductProbeWorkspace(targetPath) {
  const probeWorkspace = path.join(artifactDir, "product-probe-workspace");
  try {
    fs.rmSync(probeWorkspace, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(probeWorkspace), { recursive: true });
    fs.cpSync(targetPath, probeWorkspace, {
      recursive: true,
      filter: (source) => ![".git", "node_modules"].includes(path.basename(source)),
    });
    return {
      strategy: "copied-target",
      sourcePath: targetPath,
      workspacePath: probeWorkspace,
      copied: true,
      isolated: !samePath(probeWorkspace, targetPath),
      skippedDirectories: [".git", "node_modules"],
      reason: "Product readiness commands run against a copied target so workflow probes cannot mutate terminal product state.",
    };
  } catch (error) {
    return {
      strategy: "copied-target",
      sourcePath: targetPath,
      workspacePath: undefined,
      copied: false,
      isolated: false,
      skippedDirectories: [".git", "node_modules"],
      reason: `Failed to create isolated product probe workspace: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function runNpmScript(scriptName, outputPath, options = {}) {
  const invocation = npmInvocation(scriptName);
  const cwd = options.cwd ?? path.join(workspace, "support-ui");
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
  });
  const output = [
    `$ npm run ${scriptName}`,
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
    command: `npm run ${scriptName}`,
    attempted: true,
    passed: result.status === 0,
    status: result.status,
    signal: result.signal,
    outputPath,
    cwd,
    reason: result.status === 0 ? undefined : result.error?.message ?? `npm run ${scriptName} exited with status ${result.status}`,
  };
}

async function runStartProbe(manualUrl, options) {
  const outputFd = fs.openSync(options.outputPath, "w");
  let child;
  let selectedUrl = manualUrl;
  try {
    const invocation = npmInvocation("start");
    fs.writeSync(outputFd, `$ npm run start\ncwd: ${options.cwd}\nassigned url: ${manualUrl}\n\n`);
    child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      stdio: ["ignore", outputFd, outputFd],
      windowsHide: true,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: new URL(manualUrl).port,
      },
    });

    let uiProbe = await waitForHttp(`${selectedUrl}${options.config.ui.path}`, {
      label: options.config.ui.label,
      expectText: options.config.ui.expectedText,
      timeoutMs: 7000,
    });
    if (!uiProbe.passed) {
      const printedUrl = selectPrintedUrl(options.outputPath);
      if (printedUrl && printedUrl !== manualUrl) {
        selectedUrl = printedUrl;
        uiProbe = await waitForHttp(`${selectedUrl}${options.config.ui.path}`, {
          label: options.config.ui.label,
          expectText: options.config.ui.expectedText,
          timeoutMs: 5000,
        });
      }
    }
    const apiProbe = options.config.api
      ? await waitForHttp(`${selectedUrl}${options.config.api.path}`, {
          label: options.config.api.label,
          expectJsonFields: options.config.api.expectedJsonFields,
          timeoutMs: 5000,
        })
      : { label: "api-disabled", passed: true, reason: "No API probe configured." };
    const workflowProbe = options.config.workflow
      ? await runWorkflowProbe(selectedUrl, options.config.workflow)
      : { label: "workflow-disabled", passed: true, reason: "No workflow probe configured." };
    const probes = { ui: uiProbe, api: apiProbe, workflow: workflowProbe };
    const passed = Object.values(probes).every((probe) => probe.passed);
    const result = {
      command: "npm run start",
      attempted: true,
      passed,
      manualUrl: selectedUrl,
      assignedManualUrl: manualUrl,
      outputPath: options.outputPath,
      probeOutputPath: options.probeOutputPath,
      probeMarkdownPath: options.probeMarkdownPath,
      cwd: options.cwd,
      probeIsolation: options.probeIsolation,
      probes,
      reason: passed ? undefined : Object.values(probes).find((probe) => !probe.passed)?.reason,
    };
    const probeReport = {
      generatedAt: new Date().toISOString(),
      manualUrl: selectedUrl,
      assignedManualUrl: manualUrl,
      passed,
      cwd: options.cwd,
      productTarget: options.probeIsolation?.sourcePath,
      probeIsolation: options.probeIsolation,
      probes,
    };
    fs.writeFileSync(options.probeOutputPath, `${JSON.stringify(probeReport, null, 2)}\n`, "utf8");
    fs.writeFileSync(options.probeMarkdownPath, renderProductProbeMarkdown(probeReport), "utf8");
    return result;
  } catch (error) {
    return {
      command: "npm run start",
      attempted: true,
      passed: false,
      manualUrl: selectedUrl,
      assignedManualUrl: manualUrl,
      outputPath: options.outputPath,
      cwd: options.cwd,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    terminateProcessTree(child);
    fs.closeSync(outputFd);
  }
}

async function waitForHttp(url, { label, expectText = [], expectJsonFields = [], timeoutMs }) {
  const expectedJsonFields = Array.isArray(expectJsonFields)
    ? expectJsonFields
    : expectJsonFields
      ? [expectJsonFields]
      : [];
  const deadline = Date.now() + timeoutMs;
  let lastResult = {
    label,
    url,
    passed: false,
    expectedText: expectText,
    expectedJsonFields,
    reason: "No response before timeout.",
  };
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const body = await response.text();
      let json;
      let jsonParseError;
      try {
        json = JSON.parse(body);
      } catch (error) {
        jsonParseError = error instanceof Error ? error.message : String(error);
      }
      const expectedTextValues = Array.isArray(expectText) ? expectText : expectText ? [expectText] : [];
      const missingJsonFields = expectedJsonFields.filter((field) => !json || !Object.prototype.hasOwnProperty.call(json, field));
      const textMatched = expectedTextValues.length === 0 || expectedTextValues.some((text) => body.includes(text));
      const passed = response.ok && textMatched && missingJsonFields.length === 0;
      lastResult = {
        label,
        url,
        passed,
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get("content-type"),
        expectedText: expectedTextValues,
        textMatched,
        expectedJsonFields,
        jsonFieldsPresent: Object.fromEntries(expectedJsonFields.map((field) => [field, Boolean(json && Object.prototype.hasOwnProperty.call(json, field))])),
        missingJsonFields,
        jsonPreview: json && typeof json === "object" ? Object.fromEntries(Object.entries(json).slice(0, 10)) : undefined,
        jsonParseError: expectedJsonFields.length > 0 ? jsonParseError : undefined,
        bodySnippet: body.slice(0, 500),
        reason: passed
          ? undefined
          : !response.ok
            ? `HTTP ${response.status}`
            : !textMatched
              ? `Missing expected text: ${expectedTextValues.join(" | ")}`
              : `Missing expected JSON fields: ${missingJsonFields.join(", ")}`,
      };
      if (passed) return lastResult;
    } catch (error) {
      lastResult = {
        label,
        url,
        passed: false,
        expectedText: expectText,
        expectedJsonFields,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    await delay(250);
  }
  return lastResult;
}

async function runWorkflowProbe(manualUrl, workflow) {
  if (workflow.kind !== "configured-http-workflow") {
    return { label: "configured-http-workflow", passed: false, reason: `Unsupported workflow kind: ${workflow.kind}` };
  }
  try {
    const summaryPath = normalizeProbePath(workflow.summaryPath, "/api/summary");
    const beforeSummary = await readJson(`${manualUrl}${summaryPath}`);
    const assignment = await requestJson(manualUrl, workflow.assignment);
    const status = await requestJson(manualUrl, workflow.status);
    const note = await requestJson(manualUrl, workflow.note);
    const detail = await requestJson(manualUrl, workflow.detail ?? { method: "GET", path: `/api/tickets/${workflow.ticketId}` });
    const afterSummary = await readJson(`${manualUrl}${summaryPath}`);
    const expectedNoteBody = workflow.detail?.expectedNoteBody ?? workflow.note?.body?.body;
    const ticket = normalizeTicket(detail);
    const noteRecorded = noteBodyRecorded(ticket, expectedNoteBody);
    const deltaOk = !workflow.summaryDelta || afterSummary[workflow.summaryDelta.field] === beforeSummary[workflow.summaryDelta.field] + workflow.summaryDelta.change;
    const passed = assignment.ok && status.ok && note.ok && detail.ok && noteRecorded && deltaOk;
    return {
      label: "configured-http-workflow",
      passed,
      beforeSummary,
      afterSummary,
      assignmentStatus: assignment.status,
      assignmentPreview: previewResponseBody(assignment),
      statusTransitionStatus: status.status,
      statusTransitionPreview: previewResponseBody(status),
      noteStatus: note.status,
      notePreview: previewResponseBody(note),
      detailStatus: detail.status,
      noteRecorded,
      detailPreview: ticket && typeof ticket === "object" ? Object.fromEntries(Object.entries(ticket).slice(0, 12)) : ticket,
      summaryDelta: workflow.summaryDelta,
      deltaOk,
      reason: passed ? undefined : "Configured workflow did not satisfy all HTTP/detail/summary checks.",
    };
  } catch (error) {
    return {
      label: "configured-http-workflow",
      passed: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function noteBodyRecorded(ticket, expectedNoteBody) {
  if (!expectedNoteBody) return true;
  const noteLists = [ticket?.internalNotes, ticket?.notes].filter(Array.isArray);
  if (
    noteLists.some((items) =>
      items.some((item) => {
        if (typeof item === "string") return item.includes(expectedNoteBody);
        return item?.body === expectedNoteBody || item?.text === expectedNoteBody || JSON.stringify(item).includes(expectedNoteBody);
      }),
    )
  ) {
    return true;
  }
  if (ticket?.latestNoteBody === expectedNoteBody || ticket?.latestNote === expectedNoteBody) return true;
  return JSON.stringify(ticket ?? {}).includes(expectedNoteBody);
}

function previewResponseBody(response) {
  const body = response?.body;
  if (body && typeof body === "object") return Object.fromEntries(Object.entries(body).slice(0, 12));
  if (typeof response?.text === "string" && response.text.length > 0) return response.text.slice(0, 500);
  return body;
}

async function requestJson(manualUrl, step) {
  const method = step?.method ?? "GET";
  const pathValue = normalizeProbePath(step?.path, "/");
  const response = await fetch(`${manualUrl}${pathValue}`, {
    method,
    headers: step?.body ? { "content-type": "application/json" } : undefined,
    body: step?.body ? JSON.stringify(step.body) : undefined,
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  return { ok: response.ok, status: response.status, body, text };
}

async function readJson(url) {
  const result = await requestJson("", { method: "GET", path: url });
  if (!result.ok) throw new Error(`${url} returned HTTP ${result.status}: ${result.text?.slice(0, 200) ?? ""}`);
  return result.body;
}

function normalizeTicket(response) {
  const body = response?.body ?? response;
  if (body?.ticket && typeof body.ticket === "object") return body.ticket;
  return body;
}

function normalizeProductProbeConfig(config = {}) {
  const selected = config && typeof config === "object" ? config : {};
  return {
    ui: {
      label: normalizeNonEmptyString(selected.ui?.label, "support-triage-html"),
      path: normalizeProbePath(selected.ui?.path, "/"),
      expectedText: normalizeStringList(selected.ui?.expectedText),
    },
    api: selected.api === false
      ? undefined
      : {
          label: normalizeNonEmptyString(selected.api?.label, "support-triage-summary-api"),
          path: normalizeProbePath(selected.api?.path, "/api/summary"),
          expectedJsonFields: normalizeStringList(selected.api?.expectedJsonFields),
        },
    workflow: selected.workflow === false || !selected.workflow
      ? undefined
      : {
          kind: normalizeNonEmptyString(selected.workflow.kind, ""),
          summaryPath: normalizeProbePath(selected.workflow.summaryPath, selected.api?.path ?? "/api/summary"),
          ticketId: normalizeNonEmptyString(selected.workflow.ticketId, "TCK-100"),
          assignment: selected.workflow.assignment,
          status: selected.workflow.status,
          note: selected.workflow.note,
          detail: selected.workflow.detail,
          summaryDelta: selected.workflow.summaryDelta,
        },
  };
}

function normalizeStringList(value) {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return values.map((item) => String(item).trim()).filter(Boolean);
}

function normalizeNonEmptyString(value, fallback) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function normalizeProbePath(value, fallback) {
  const selected = normalizeNonEmptyString(value, fallback);
  if (/^https?:\/\//i.test(selected)) return selected;
  return selected.startsWith("/") ? selected : `/${selected}`;
}

async function allocateLocalProbePort() {
  const script = `import net from "node:net";
const server = net.createServer();
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  console.log(address.port);
  server.close();
});`;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const port = Number.parseInt(output, 10);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`Unable to allocate local product probe port from output: ${output}`);
  return port;
}

function npmInvocation(scriptName) {
  if (process.platform === "win32") {
    const npmCliPath = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (fs.existsSync(npmCliPath)) {
      return { command: process.execPath, args: [npmCliPath, "run", scriptName] };
    }
  }
  return { command: "npm", args: ["run", scriptName] };
}

function selectPrintedUrl(outputPath) {
  if (!fs.existsSync(outputPath)) return undefined;
  const content = fs.readFileSync(outputPath, "utf8");
  return /http:\/\/127\.0\.0\.1:\d+/i.exec(content)?.[0];
}

function terminateProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  child.kill("SIGTERM");
}

function renderProductReadinessMarkdown(readiness) {
  const lines = [
    "# H2 Product Readiness",
    "",
    `Generated: ${readiness.generatedAt}`,
    `Product: ${readiness.productName}`,
    `Passed: ${readiness.passed ? "yes" : "no"}`,
    `Manual URL: ${readiness.commands.manualUrl}`,
    "",
    "## Checks",
    "",
    "| Check | Result | Severity | Detail |",
    "| --- | --- | --- | --- |",
  ];
  for (const check of readiness.checks) {
    lines.push(`| ${escapeTable(check.label)} | ${check.passed ? "passed" : "failed"} | ${escapeTable(check.severity)} | ${escapeTable(check.message)} |`);
  }
  lines.push("", "## Blockers", "");
  if (readiness.blockers.length === 0) {
    lines.push("None.");
  } else {
    for (const blocker of readiness.blockers) lines.push(`- ${blocker.label}: ${blocker.message}`);
  }
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
    "# H2 Product Probe",
    "",
    `Generated: ${probe.generatedAt}`,
    `Manual URL: ${probe.manualUrl}`,
    `Passed: ${probe.passed ? "yes" : "no"}`,
    "",
    "## Probes",
    "",
    "| Probe | Result | Detail |",
    "| --- | --- | --- |",
  ];
  for (const [key, result] of Object.entries(probe.probes)) {
    lines.push(`| ${escapeTable(result.label ?? key)} | ${result.passed ? "passed" : "failed"} | ${escapeTable(result.reason ?? result.url ?? "")} |`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function escapeTable(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function inspectSourceMutations(sources) {
  return sources.map((source) => {
    if (!source.hash) return { id: source.id, title: source.title, uri: source.uri, mutated: false, reason: "No registered source hash was available." };
    if (!fs.existsSync(source.uri)) {
      return { id: source.id, title: source.title, uri: source.uri, expectedHash: source.hash, mutated: true, reason: "Source file is missing." };
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

function humanActionSummary() {
  return withStore((store) => buildHumanActionQueue(store, workspace));
}

function terminalHumanInterventionActions(summary) {
  return (summary.actions ?? []).filter(
    (action) =>
      action.kind === "decision_required" ||
      action.kind === "human_verification",
  );
}

function humanVerificationReworkActions(summary) {
  return (summary.actions ?? []).filter((action) => action.kind === "human_verification_rework");
}

function withStore(callback) {
  const store = new SwarmStore(workspace);
  try {
    return callback(store);
  } finally {
    store.close();
  }
}

function observe(events) {
  return JSON.parse(runSwarm(["observe", "--events", String(events)]));
}

function runSwarm(commandArgs, env = {}) {
  return execFileSync(process.execPath, [cli, ...commandArgs], {
    cwd: workspace,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 50 * 1024 * 1024,
  });
}

function readManifest() {
  return readJsonFile(manifestPath) ?? {};
}

function updateManifest(patch) {
  if (!fs.existsSync(manifestPath)) return;
  const current = readManifest();
  fs.writeFileSync(manifestPath, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`, "utf8");
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return { parseError: error instanceof Error ? error.message : String(error) };
  }
}

function assertApprovedWorkspace(target) {
  const demoRoot = path.join(repoRoot, ".swarm-demo");
  const resolved = path.resolve(target);
  if (!resolved.toLowerCase().startsWith(`${demoRoot.toLowerCase()}${path.sep}`)) {
    throw new Error(`Refusing to run H2 live smoke outside ${demoRoot}: ${resolved}`);
  }
  if (samePath(resolved, repoRoot) || samePath(resolved, path.dirname(repoRoot)) || samePath(resolved, demoRoot)) {
    throw new Error(`Refusing unsafe H2 live smoke workspace: ${resolved}`);
  }
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = rawArgs[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function compactTimestamp(value) {
  return value.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace(/[^0-9TZ]/g, "");
}

function safeRunId(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 120);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
