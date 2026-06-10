#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const driver = args.driver ?? "codex";
if (!["fixture", "codex"].includes(driver)) {
  throw new Error(`Invalid --driver ${driver}; expected fixture or codex`);
}

const defaultWorkspace = path.join(repoRoot, ".swarm-demo", "live-agent-smoke");
const workspace = path.resolve(args.workspace ?? defaultWorkspace);
const noReset = args["no-reset"] === "true";
const summaryPath = path.resolve(args.summary ?? path.join(workspace, "live-agent-scripted-summary.json"));
const artifactsPath = path.resolve(args.artifacts ?? path.join(workspace, "live-agent-scripted-artifacts"));
const cli = path.join(repoRoot, "dist", "cli.js");
const resetScript = path.join(repoRoot, "scripts", "reset-live-agent-smoke.mjs");
const invoiceTemplate = path.join(repoRoot, "fixtures", "templates", "invoice-api");
const dashboardTemplate = path.join(repoRoot, "fixtures", "templates", "invoice-dashboard");
const sourceProductSpec = path.join(repoRoot, "docs", "requirements", "live-smoke-invoice-dashboard-product-spec.md");

const invoiceTarget = path.join(workspace, "invoice-api");
const dashboardTarget = path.join(workspace, "invoice-dashboard");
const productSpec = path.join(workspace, "source-specs", "live-smoke-invoice-dashboard-product-spec.md");
const invoiceSpec = path.join(invoiceTarget, "specs", "invoice-api.md");
const manifestPath = path.join(workspace, "live-agent-smoke.json");

assertApprovedWorkspace(workspace);
if (!fs.existsSync(cli)) throw new Error(`Built CLI not found: ${cli}. Run npm run build first.`);

if (!noReset) {
  resetScenario();
}
ensureWorkspaceInitialized();
runSwarm(["run-mode", "set", driver === "codex" ? "scripted-codex" : "fixture"]);
updateManifest({ phase: "phase-3-scripted-worker-reviewer", runMode: driver === "codex" ? "scripted-codex" : "fixture" });

const sliceId = pullSlice([
  "--target",
  "invoice-api",
  "--source",
  "invoice-api.md",
  "--new-lane",
  "--lane-name",
  "Scripted Backend Lane: Invoice Query Core",
  "--lane-purpose",
  "Rehearse real worker and reviewer lifecycle on a backend capability slice",
  "--lane-labels",
  "backend,invoice-api,scripted-live-smoke",
  "--orchestrator",
  "scripted-live-smoke-runner",
  "--batch-size",
  "3",
]);

const workerOutput = runSwarm(["run", sliceId, "--actor", "scripted-backend-worker", "--driver", driver]);
const reviewOutput = runSwarm(["review", sliceId, "--actor", "scripted-independent-reviewer", "--driver", driver]);
const verifyOutput = runSwarm(["verify", sliceId, "--actor", "scripted-deterministic-verifier", "--force"]);

const finalSnapshot = JSON.parse(runSwarm(["observe", "--events", "120"]));
const graph = JSON.parse(runSwarm(["graph", "--format", "json"]));
const report = runSwarm(["report", sliceId]);
const timeline = JSON.parse(runSwarm(["timeline", sliceId, "--json"]));
const finalSlice = finalSnapshot.slices.find((slice) => slice.id === sliceId);
if (!finalSlice) throw new Error(`Final slice missing from snapshot: ${sliceId}`);

fs.mkdirSync(artifactsPath, { recursive: true });
const snapshotPath = path.join(artifactsPath, "observe.json");
const graphPath = path.join(artifactsPath, "graph.json");
const reportPath = path.join(artifactsPath, "slice-report.md");
const timelinePath = path.join(artifactsPath, "timeline.json");
const workerOutputPath = path.join(artifactsPath, "worker-output.txt");
const reviewOutputPath = path.join(artifactsPath, "review-output.txt");
const verifyOutputPath = path.join(artifactsPath, "verify-output.txt");

fs.writeFileSync(snapshotPath, `${JSON.stringify(finalSnapshot, null, 2)}\n`, "utf8");
fs.writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
fs.writeFileSync(reportPath, report, "utf8");
fs.writeFileSync(timelinePath, `${JSON.stringify(timeline, null, 2)}\n`, "utf8");
fs.writeFileSync(workerOutputPath, workerOutput, "utf8");
fs.writeFileSync(reviewOutputPath, reviewOutput, "utf8");
fs.writeFileSync(verifyOutputPath, verifyOutput, "utf8");

const workerRun = finalSnapshot.agentRuns.find((run) => run.actor === "scripted-backend-worker" && run.sliceId === sliceId);
const reviewerRun = finalSnapshot.agentRuns.find((run) => run.actor === "scripted-independent-reviewer" && run.sliceId === sliceId);
const commandEvidence = finalSlice.evidence.filter((item) => item.kind === "command").at(-1);
const reviewEvidence = finalSlice.evidence.filter((item) => item.kind === "review_result").at(-1);
const sourceMutationFindings = reviewEvidence?.payload?.sourceMutationsAfter;
const sourceMutated = Array.isArray(sourceMutationFindings) && sourceMutationFindings.some((item) => item.mutated);
const blockingEscalations = finalSnapshot.activeEscalations.filter(
  (item) => item.entityId === sliceId && ["blocker", "human_required", "critical"].includes(item.level),
);
const finalOutcome = blockingEscalations.some((item) => item.level === "human_required" || item.level === "critical")
  ? "human_required"
  : finalSlice.status === "accepted"
    ? "accepted"
    : "blocked";

const summary = {
  workspace,
  driver,
  runMode: finalSnapshot.runMode,
  generatedAt: new Date().toISOString(),
  phase: "phase-3-scripted-worker-reviewer",
  finalOutcome,
  sliceId,
  finalSliceStatus: finalSlice.status,
  counts: {
    targets: finalSnapshot.targets.length,
    sources: finalSnapshot.sources.length,
    lanes: finalSnapshot.lanes.length,
    slices: finalSnapshot.slices.length,
    agentRuns: finalSnapshot.agentRuns.length,
    evidence: finalSlice.evidence.length,
    activeEscalations: finalSnapshot.activeEscalations.length,
    graphNodes: graph.nodes.length,
    graphEdges: graph.edges.length,
    timelineItems: timeline.items.length,
  },
  runs: {
    worker: workerRun,
    reviewer: reviewerRun,
  },
  review: finalSlice.reviewResult,
  assertions: {
    runModeIsScripted: driver === "codex" ? finalSnapshot.runMode === "scripted-codex" : finalSnapshot.runMode === "fixture",
    pulledBackendSlice: finalSlice.targetId === finalSnapshot.targets.find((target) => target.name === "invoice-api")?.id,
    workerRunCompleted: workerRun?.status === "completed",
    workerRunUsesConfiguredDriver: workerRun?.driver === driver,
    reviewerRunCompleted: reviewerRun?.status === "completed",
    reviewerRunUsesConfiguredDriver: reviewerRun?.driver === driver,
    reviewerEvidenceRecorded: Boolean(reviewEvidence),
    deterministicCommandEvidenceRecorded: Boolean(commandEvidence),
    reportShowsLatestReview: report.includes("Latest review:") && report.includes("status:"),
    finalOutcomeIsBounded: ["accepted", "blocked", "human_required"].includes(finalOutcome),
    sourceSpecsUnchanged: !sourceMutated,
    acceptedHasCompletedLeases: finalOutcome !== "accepted" || finalSlice.leases.every((lease) => lease.status === "completed"),
    blockedHasVisibleReason: finalOutcome === "accepted" || blockingEscalations.length > 0 || verifyOutput.includes("Verification failed"),
    graphShowsWorkerAndReviewer:
      graph.nodes.some((node) => node.type === "actor" && node.label === "scripted-backend-worker") &&
      graph.nodes.some((node) => node.type === "actor" && node.label === "scripted-independent-reviewer"),
  },
  artifacts: {
    summary: summaryPath,
    snapshot: snapshotPath,
    graph: graphPath,
    report: reportPath,
    timeline: timelinePath,
    workerOutput: workerOutputPath,
    reviewOutput: reviewOutputPath,
    verifyOutput: verifyOutputPath,
    workerEvents: workerRun?.eventsPath,
    workerResult: workerRun?.resultPath,
    reviewerEvents: reviewerRun?.eventsPath,
    reviewerResult: reviewerRun?.resultPath,
  },
};

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
    path.join(dashboardTarget, "specs", "invoice-dashboard.md"),
    "--domain",
    "Invoice Dashboard",
    "--tags",
    "frontend,dashboard,invoices",
    "--priority",
    "3",
  ]);
  const snapshot = JSON.parse(runSwarm(["observe", "--events", "40"]));
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        scenarioId: "live-agent-smoke",
        runMode: "live-agent-smoke",
        phase: "phase-1-reset-and-run-mode",
        generatedAt: new Date().toISOString(),
        workspace,
        productSpec,
        expectedOutcome: "accepted_product_or_blocked_with_reasons",
        targets: [
          {
            name: "invoice-api",
            path: invoiceTarget,
            role: "backend",
            source: invoiceSpec,
          },
          {
            name: "invoice-dashboard",
            path: dashboardTarget,
            role: "frontend",
            source: path.join(dashboardTarget, "specs", "invoice-dashboard.md"),
          },
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
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        ...current,
        ...patch,
        scriptedRun: {
          command: "npm run demo:live-agent:scripted",
          driver,
          summary: summaryPath,
          updatedAt: new Date().toISOString(),
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function runSwarm(commandArgs) {
  return execFileSync(process.execPath, [cli, ...commandArgs], {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
}

function pullSlice(commandArgs) {
  const output = runSwarm(["slices", "pull", ...commandArgs]);
  const match = /Created slice (SLICE-[a-f0-9]+)/i.exec(output);
  if (!match) throw new Error(`Could not parse created slice from output:\n${output}`);
  return match[1];
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
