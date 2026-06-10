#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const driver = args.driver ?? "fixture";
if (!["fixture", "codex"].includes(driver)) {
  throw new Error(`Invalid --driver ${driver}; expected fixture or codex`);
}

const workspace = path.resolve(args.workspace ?? path.join(repoRoot, ".swarm-demo", "resume-context"));
const summaryPath = path.resolve(args.summary ?? path.join(workspace, "resume-context-summary.json"));
const artifactsDir = path.resolve(args.artifacts ?? path.join(workspace, "resume-context-artifacts"));
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

const initialSnapshot = JSON.parse(runSwarm(["observe", "--events", "160"]));
const dashboardSliceId = invoiceOutput.slices.at(-1);
const dashboardSlice = initialSnapshot.slices.find((slice) => slice.id === dashboardSliceId);
if (!dashboardSlice) throw new Error(`Dashboard slice not found in snapshot: ${dashboardSliceId}`);
const dashboardRun = initialSnapshot.agentRuns.find(
  (run) => run.sliceId === dashboardSliceId && run.actor === "frontend-worker-dashboard",
);
if (!dashboardRun) throw new Error(`Dashboard worker run not found for ${dashboardSliceId}`);

const firstWorkerCheckpoint = parseCheckpointId(
  runSwarm(["checkpoint", "create", "--entity", `slice:${dashboardSliceId}`, "--role", "worker", "--actor", "resume-demo"]),
);
const secondWorkerCheckpoint = parseCheckpointId(
  runSwarm(["checkpoint", "create", "--entity", `slice:${dashboardSliceId}`, "--role", "worker", "--actor", "resume-demo"]),
);

const workerPacket = runSwarm(["resume-context", "--entity", `slice:${dashboardSliceId}`, "--role", "worker"]);
const verifierPacket = runSwarm(["resume-context", "--entity", `slice:${dashboardSliceId}`, "--role", "verifier"]);
const reviewerPacket = runSwarm(["resume-context", "--entity", `slice:${dashboardSliceId}`, "--role", "reviewer"]);
const plannerPacket = runSwarm(["resume-context", "--entity", `lane:${dashboardSlice.laneId}`, "--role", "planner"]);
const overseerPacket = runSwarm(["resume-context", "--entity", `lane:${dashboardSlice.laneId}`, "--role", "overseer"]);
const recoveryPacket = runSwarm(["resume-context", "--run", dashboardRun.id]);
const checkpointList = runSwarm(["checkpoint", "list"]);
const checkpointShow = runSwarm(["checkpoint", "show", firstWorkerCheckpoint]);
const finalSnapshot = JSON.parse(runSwarm(["observe", "--events", "160"]));

fs.mkdirSync(artifactsDir, { recursive: true });
const artifacts = {
  workerPacket: path.join(artifactsDir, "resume-worker.md"),
  verifierPacket: path.join(artifactsDir, "resume-verifier.md"),
  reviewerPacket: path.join(artifactsDir, "resume-reviewer.md"),
  plannerPacket: path.join(artifactsDir, "resume-planner.md"),
  overseerPacket: path.join(artifactsDir, "resume-overseer.md"),
  recoveryPacket: path.join(artifactsDir, "resume-recovery.md"),
  checkpointList: path.join(artifactsDir, "checkpoint-list.txt"),
  checkpointShow: path.join(artifactsDir, "checkpoint-show.md"),
  summary: summaryPath,
};
fs.writeFileSync(artifacts.workerPacket, workerPacket, "utf8");
fs.writeFileSync(artifacts.verifierPacket, verifierPacket, "utf8");
fs.writeFileSync(artifacts.reviewerPacket, reviewerPacket, "utf8");
fs.writeFileSync(artifacts.plannerPacket, plannerPacket, "utf8");
fs.writeFileSync(artifacts.overseerPacket, overseerPacket, "utf8");
fs.writeFileSync(artifacts.recoveryPacket, recoveryPacket, "utf8");
fs.writeFileSync(artifacts.checkpointList, checkpointList, "utf8");
fs.writeFileSync(artifacts.checkpointShow, checkpointShow, "utf8");

const matchingWorkerCheckpoints = finalSnapshot.checkpoints.filter(
  (checkpoint) =>
    checkpoint.role === "worker" &&
    checkpoint.entityType === "slice" &&
    checkpoint.entityId === dashboardSliceId,
);

const summary = {
  workspace,
  driver,
  runMode: finalSnapshot.runMode,
  generatedAt: new Date().toISOString(),
  invoice: invoiceOutput,
  selected: {
    dashboardSliceId,
    dashboardLaneId: dashboardSlice.laneId,
    dashboardRunId: dashboardRun.id,
    workerCheckpointId: firstWorkerCheckpoint,
  },
  counts: {
    checkpoints: finalSnapshot.checkpoints.length,
    recentEvents: finalSnapshot.recentEvents.length,
    workerCheckpointsForSlice: matchingWorkerCheckpoints.length,
  },
  resumeAssertions: {
    observeIncludesCheckpoints: finalSnapshot.checkpoints.length > 0,
    latestOnlyWorkerCheckpoint: firstWorkerCheckpoint === secondWorkerCheckpoint && matchingWorkerCheckpoints.length === 1,
    checkpointListMentionsRoles: checkpointList.includes("worker slice:") && checkpointList.includes("verifier slice:"),
    checkpointShowHasPayload: checkpointShow.includes("# Checkpoint") && checkpointShow.includes("Payload:"),
    workerPacketHasWorkerFocus: workerPacket.includes("## Worker Focus"),
    workerPacketHasGuardrails: workerPacket.includes("## Guardrails") && workerPacket.includes("Do not mutate immutable source specs"),
    workerPacketHasFrAcScope: workerPacket.includes("## FR/AC Scope") && workerPacket.includes("AC-UI-INV-001.1"),
    workerPacketHasEvidenceStatus: workerPacket.includes("## Evidence Status") && workerPacket.includes("passed"),
    verifierPacketHasChecklist: verifierPacket.includes("## Verifier Focus") && verifierPacket.includes("Per-FR/AC checklist"),
    reviewerPacketHasDriftChecks: reviewerPacket.includes("## Reviewer / Sleuth Focus") && reviewerPacket.includes("scope drift"),
    plannerPacketHasPlannerFocus: plannerPacket.includes("## Planner / Overseer Focus") && plannerPacket.includes("Recent planner decisions"),
    overseerPacketHasPlannerFocus: overseerPacket.includes("## Planner / Overseer Focus") && overseerPacket.includes("Next planning decision"),
    recoveryPacketHasRecommendation: recoveryPacket.includes("## Recovery Focus") && recoveryPacket.includes("Revive/restart recommendation"),
    recoveryPacketHasArtifacts: recoveryPacket.includes("## Artifacts") && recoveryPacket.includes("worker-result.json"),
  },
  artifacts,
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

function parseCheckpointId(output) {
  const match = /Refreshed checkpoint (CHK-[a-f0-9]+)/i.exec(output);
  if (!match) throw new Error(`Could not parse checkpoint id from output:\n${output}`);
  return match[1];
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
