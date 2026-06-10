#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { SwarmStore } from "../dist/storage.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const driver = args.driver ?? "fixture";
if (!["fixture", "codex"].includes(driver)) {
  throw new Error(`Invalid --driver ${driver}; expected fixture or codex`);
}

const workspace = path.resolve(args.workspace ?? path.join(repoRoot, ".swarm-demo", "observability"));
const summaryPath = path.resolve(args.summary ?? path.join(workspace, "observability-summary.json"));
const cli = path.join(repoRoot, "dist", "cli.js");

const invoiceOutput = JSON.parse(
  execFileSync(process.execPath, [
    path.join(repoRoot, "scripts", "run-invoice-demo.mjs"),
    "--driver",
    driver,
    "--workspace",
    workspace,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }),
);

const staleRunId = "RUN-observe-stale";
const staleSliceId = invoiceOutput.slices[0];
const staleTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
const store = new SwarmStore(workspace);
try {
  store.insertAgentRun({
    id: staleRunId,
    sliceId: staleSliceId,
    actor: "observability-stale-worker",
    driver: "fixture",
    status: "running",
    attempt: 1,
    startedAt: staleTimestamp,
    updatedAt: staleTimestamp,
  });
  store.upsertHeartbeat({
    id: "heartbeat:observability-stale-worker",
    actor: "observability-stale-worker",
    state: "thinking",
    detail: "Synthetic stale run for observability demo",
    entityType: "slice",
    entityId: staleSliceId,
    timestamp: staleTimestamp,
  });
} finally {
  store.close();
}

const staleScan = runSwarm(["recovery", "scan", "--stale-after", "60"]);
runSwarm(["recovery", "scan", "--stale-after", "60", "--mark-stale"]);
const restartOutput = runSwarm(["recovery", "restart", staleRunId, "--driver", "fixture"]);
const finalSnapshot = JSON.parse(runSwarm(["observe", "--events", "120"]));
const watchAgents = runSwarm(["watch", "--once", "--no-clear", "--view", "agents", "--events", "10"]);
const watchBlockers = runSwarm(["watch", "--once", "--no-clear", "--view", "blockers", "--events", "10"]);
const timeline = JSON.parse(runSwarm(["timeline", staleSliceId, "--json"]));
const graph = JSON.parse(runSwarm(["graph", "--format", "json"]));
const report = runSwarm(["report", staleSliceId]);

const summary = {
  workspace,
  driver,
  runMode: finalSnapshot.runMode,
  generatedAt: new Date().toISOString(),
  invoice: invoiceOutput,
  staleRunId,
  staleSliceId,
  staleScan,
  restartOutput,
  counts: {
    targets: finalSnapshot.targets.length,
    sources: finalSnapshot.sources.length,
    lanes: finalSnapshot.lanes.length,
    slices: finalSnapshot.slices.length,
    agentRuns: finalSnapshot.agentRuns.length,
    activeEscalations: finalSnapshot.activeEscalations.length,
    graphNodes: graph.nodes.length,
    graphEdges: graph.edges.length,
    timelineItems: timeline.items.length,
  },
  observabilityAssertions: {
    hasWorkerEvents: finalSnapshot.recentEvents.some((event) => event.type === "worker.agent_event"),
    hasRecoveryEvents: finalSnapshot.recentEvents.some((event) => event.type.startsWith("recovery.")),
    hasRestartRun: finalSnapshot.agentRuns.some((run) => run.id !== staleRunId && run.sliceId === staleSliceId && run.status === "completed"),
    watchAgentsMentionsRuns: watchAgents.includes("Agent Runs") && watchAgents.includes("RUN-"),
    watchBlockersMentionsEscalation: watchBlockers.includes("Agent run RUN-observe-stale is stale"),
    timelineMentionsRecovery: timeline.items.some((item) => item.kind === "event" && item.label.includes("recovery.")),
    graphHasEvidence: graph.edges.some((edge) => edge.type === "evidence"),
    reportMentionsEscalation: report.includes("RUN-observe-stale"),
  },
  artifacts: {
    snapshot: invoiceOutput.snapshot,
    summary: summaryPath,
  },
};

fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify(summary, null, 2));

function runSwarm(commandArgs) {
  return execFileSync(process.execPath, [cli, ...commandArgs], {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
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
