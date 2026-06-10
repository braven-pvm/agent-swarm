#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const defaultWorkspace = path.join(repoRoot, ".swarm-demo", "live-agent-smoke");
const workspace = path.resolve(args.workspace ?? defaultWorkspace);

assertApprovedWorkspace(workspace);

const cli = path.join(repoRoot, "dist", "cli.js");
const invoiceTemplate = path.join(repoRoot, "fixtures", "templates", "invoice-api");
const dashboardTemplate = path.join(repoRoot, "fixtures", "templates", "invoice-dashboard");
const sourceProductSpec = path.join(repoRoot, "docs", "requirements", "live-smoke-invoice-dashboard-product-spec.md");

const invoiceTarget = path.join(workspace, "invoice-api");
const dashboardTarget = path.join(workspace, "invoice-dashboard");
const sourceSpecsDir = path.join(workspace, "source-specs");
const productSpec = path.join(sourceSpecsDir, "live-smoke-invoice-dashboard-product-spec.md");
const manifestPath = path.join(workspace, "live-agent-smoke.json");

resetWorkspace();
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
  path.join(invoiceTarget, "specs", "invoice-api.md"),
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
const manifest = {
  scenarioId: "live-agent-smoke",
  runMode: "live-agent-smoke",
  phase: "phase-1-reset-and-run-mode",
  generatedAt: new Date().toISOString(),
  workspace,
  productSpec,
  expectedOutcome: "accepted_product_or_blocked_with_reasons",
  limits: {
    maxSlices: 5,
    maxAgentRuns: 12,
    maxRuntimeMinutes: 45,
  },
  fullProductMode: {
    plannedCommand: "npm run demo:live-agent:full",
    productSpec: path.relative(repoRoot, sourceProductSpec).replace(/\\/g, "/"),
    maxSlices: 12,
    maxAgentRuns: 30,
    maxRuntimeMinutes: 120,
  },
  targets: [
    {
      name: "invoice-api",
      path: invoiceTarget,
      role: "backend",
      source: path.join(invoiceTarget, "specs", "invoice-api.md"),
      gitInitialized: tryGitStatus(invoiceTarget),
    },
    {
      name: "invoice-dashboard",
      path: dashboardTarget,
      role: "frontend",
      source: path.join(dashboardTarget, "specs", "invoice-dashboard.md"),
      gitInitialized: tryGitStatus(dashboardTarget),
    },
  ],
  sources: snapshot.sources.map((source) => ({
    id: source.id,
    title: source.title,
    uri: source.uri,
    hash: source.hash,
    domain: source.metadata?.domain ?? "Unassigned",
  })),
  commands: {
    serve: "npm run demo:live-agent:serve",
    futureRun: "npm run demo:live-agent:run",
    futureFullProduct: "npm run demo:live-agent:full",
  },
};

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const summary = {
  workspace,
  runMode: snapshot.runMode,
  manifest: manifestPath,
  counts: {
    targets: snapshot.targets.length,
    sources: snapshot.sources.length,
    domains: snapshot.domains.length,
    slices: snapshot.slices.length,
    agentRuns: snapshot.agentRuns.length,
  },
  sources: manifest.sources,
};

console.log(JSON.stringify(summary, null, 2));

function resetWorkspace() {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(invoiceTemplate, invoiceTarget, { recursive: true });
  fs.cpSync(dashboardTemplate, dashboardTarget, { recursive: true });
  fs.mkdirSync(sourceSpecsDir, { recursive: true });
  fs.copyFileSync(sourceProductSpec, productSpec);
  tryInitGit(invoiceTarget);
  tryInitGit(dashboardTarget);
}

function runSwarm(commandArgs) {
  return execFileSync(process.execPath, [cli, ...commandArgs], {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
}

function assertApprovedWorkspace(target) {
  if (!samePath(target, defaultWorkspace)) {
    throw new Error(`Refusing to reset workspace outside approved live smoke root: ${defaultWorkspace}`);
  }
  if (samePath(target, repoRoot) || samePath(path.dirname(target), repoRoot)) {
    throw new Error(`Refusing unsafe live smoke workspace: ${target}`);
  }
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function tryInitGit(repoPath) {
  try {
    execFileSync("git", ["init"], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "live-smoke@example.local"], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Live Smoke Reset"], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "Initial live smoke target"], { cwd: repoPath, stdio: "ignore" });
  } catch {
    return false;
  }
  return true;
}

function tryGitStatus(repoPath) {
  try {
    execFileSync("git", ["status", "--short"], { cwd: repoPath, stdio: "ignore" });
  } catch {
    return false;
  }
  return true;
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
