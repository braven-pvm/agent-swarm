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

const workspace = path.resolve(args.workspace ?? path.join(repoRoot, ".swarm-demo", "invoice"));
const demoRoot = path.join(repoRoot, ".swarm-demo");
if (!workspace.toLowerCase().startsWith(demoRoot.toLowerCase())) {
  throw new Error(`Refusing to reset workspace outside ${demoRoot}: ${workspace}`);
}

const template = path.join(repoRoot, "fixtures", "templates", "invoice-api");
const dashboardTemplate = path.join(repoRoot, "fixtures", "templates", "invoice-dashboard");
const target = path.join(workspace, "invoice-api");
const dashboardTarget = path.join(workspace, "invoice-dashboard");
const spec = path.join(target, "specs", "invoice-api.md");
const dashboardSpec = path.join(dashboardTarget, "specs", "invoice-dashboard.md");
const snapshot = path.resolve(args.snapshot ?? path.join(workspace, "invoice-observability-snapshot.json"));
const cli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const cliSource = path.join(repoRoot, "src", "cli.ts");

resetWorkspace();
runSwarm(["init"]);
runSwarm(["target", "init", target]);
runSwarm(["target", "init", dashboardTarget]);
runSwarm(["sources", "add-file", spec]);
runSwarm(["sources", "add-file", dashboardSpec]);

let blockedDashboardOutput = "";
try {
  runSwarm([
    "slices",
    "pull",
    "--target", "invoice-dashboard",
    "--source", "invoice-dashboard.md",
    "--new-lane",
    "--lane-name", "Frontend Lane: Invoice Dashboard",
    "--lane-purpose", "Compose dashboard only after backend invoice capabilities are accepted",
    "--lane-labels", "frontend,invoice-dashboard,blocked-until-backend-ready",
    "--orchestrator", "planning-agent/frontend",
    "--batch-size", "3",
  ]);
} catch (error) {
  blockedDashboardOutput = `${error.stdout ?? ""}${error.stderr ?? ""}`;
}

const querySlice = pullSlice([
  "--target", "invoice-api",
  "--source", "invoice-api.md",
  "--new-lane",
  "--lane-name", "Backend Lane: Invoice Query Core",
  "--lane-purpose", "Implement verified invoice query capabilities needed before dashboard/UI work",
  "--lane-labels", "backend,invoice-api,query-core",
  "--orchestrator", "planning-agent/backend",
  "--batch-size", "3",
]);
runSwarm(["run", querySlice, "--actor", "backend-worker-query", "--driver", driver]);
runSwarm(["verify", querySlice, "--actor", "backend-verifier-query"]);

const summarySlice = pullSlice([
  "--target", "invoice-api",
  "--source", "invoice-api.md",
  "--new-lane",
  "--lane-name", "Backend Lane: Invoice Summary Cards",
  "--lane-purpose", "Implement verified aggregate capabilities that would unblock dashboard cards",
  "--lane-labels", "backend,invoice-api,dashboard-enabler",
  "--orchestrator", "planning-agent/backend",
  "--batch-size", "2",
]);
runSwarm(["run", summarySlice, "--actor", "backend-worker-summary", "--driver", driver]);
runSwarm(["verify", summarySlice, "--actor", "backend-verifier-summary"]);

const lookupSlice = pullSlice([
  "--target", "invoice-api",
  "--source", "invoice-api.md",
  "--new-lane",
  "--lane-name", "Backend Lane: Invoice Lookup",
  "--lane-purpose", "Implement verified single-invoice lookup needed by detail views",
  "--lane-labels", "backend,invoice-api,lookup",
  "--orchestrator", "planning-agent/backend",
  "--batch-size", "2",
]);
runSwarm(["run", lookupSlice, "--actor", "backend-worker-lookup", "--driver", driver]);
runSwarm(["verify", lookupSlice, "--actor", "backend-verifier-lookup"]);

const dashboardSlice = pullSlice([
  "--target", "invoice-dashboard",
  "--source", "invoice-dashboard.md",
  "--new-lane",
  "--lane-name", "Frontend Lane: Invoice Dashboard",
  "--lane-purpose", "Compose dashboard only after backend invoice capabilities are accepted",
  "--lane-labels", "frontend,invoice-dashboard,backend-ready",
  "--orchestrator", "planning-agent/frontend",
  "--batch-size", "3",
]);
runSwarm(["run", dashboardSlice, "--actor", "frontend-worker-dashboard", "--driver", driver]);
runSwarm(["verify", dashboardSlice, "--actor", "frontend-verifier-dashboard"]);

runSwarm(["observe", "--events", "80", "--out", snapshot]);
console.log(JSON.stringify({
  workspace,
  target,
  dashboardTarget,
  snapshot,
  blockedDashboardOutput: blockedDashboardOutput.trim(),
  slices: [querySlice, summarySlice, lookupSlice, dashboardSlice],
}, null, 2));

function resetWorkspace() {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(template, target, { recursive: true });
  fs.cpSync(dashboardTemplate, dashboardTarget, { recursive: true });
}

function runSwarm(commandArgs) {
  return execFileSync(process.execPath, [cli, cliSource, ...commandArgs], {
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
