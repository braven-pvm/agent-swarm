#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const defaultWorkspace = path.join(repoRoot, ".swarm-demo", "live-agent-smoke");
const workspace = path.resolve(args.workspace ?? defaultWorkspace);
const stopRelatedProcesses = args["stop-related-processes"] === "true";

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
const liveSmokeChildIdleTimeoutSeconds = 300;

const stoppedProcesses = stopRelatedProcesses ? stopRelatedProcessesForWorkspace(workspace) : [];
resetWorkspace();
runSwarm(["init"]);
runSwarm(["run-mode", "set", "live-agent-smoke"]);
runSwarm(["target", "init", invoiceTarget]);
runSwarm(["target", "init", dashboardTarget]);
configureLiveSmokeProtocol(invoiceTarget);
configureLiveSmokeProtocol(dashboardTarget);
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
    plannedCommand: "npm run smoke:live-agent:full",
    productSpec: path.relative(repoRoot, sourceProductSpec).replace(/\\/g, "/"),
    maxSlices: 12,
    maxAgentRuns: 60,
    maxRuntimeMinutes: 45,
    maxTurns: 40,
    childIdleTimeoutSeconds: liveSmokeChildIdleTimeoutSeconds,
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
    liveRun: "npm run demo:live-agent:run",
    scripted: "npm run demo:live-agent:scripted",
    fullProduct: "npm run demo:live-agent:full",
    resetAndFullProduct: "npm run smoke:live-agent:full",
  },
};

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const summary = {
  workspace,
  runMode: snapshot.runMode,
  manifest: manifestPath,
  stoppedProcesses,
  counts: {
    targets: snapshot.targets.length,
    sources: snapshot.sources.length,
    domains: snapshot.domains.length,
    slices: snapshot.slices.length,
    agentRuns: snapshot.agentRuns.length,
  },
  recovery: {
    childIdleTimeoutSeconds: liveSmokeChildIdleTimeoutSeconds,
  },
  sources: manifest.sources,
};

console.log(JSON.stringify(summary, null, 2));

function resetWorkspace() {
  try {
    fs.rmSync(workspace, { recursive: true, force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to reset live smoke workspace ${workspace}: ${message}. Stop any active swarm serve/product processes for this workspace or rerun with --stop-related-processes.`,
    );
  }
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(invoiceTemplate, invoiceTarget, { recursive: true });
  fs.cpSync(dashboardTemplate, dashboardTarget, { recursive: true });
  fs.mkdirSync(sourceSpecsDir, { recursive: true });
  fs.copyFileSync(sourceProductSpec, productSpec);
  tryInitGit(invoiceTarget);
  tryInitGit(dashboardTarget);
}

function stopRelatedProcessesForWorkspace(targetWorkspace) {
  if (process.platform !== "win32") return [];
  const isDefaultWorkspace = samePath(targetWorkspace, defaultWorkspace);
  const script = String.raw`
$workspace = $env:SWARM_RESET_WORKSPACE
$workspaceSlash = $workspace -replace '\\','/'
$relativeToken = $env:SWARM_RESET_RELATIVE_TOKEN
$isDefault = $env:SWARM_RESET_DEFAULT -eq 'true'
$stopped = @()

function Stop-ById([int]$processId, [string]$reason) {
  if ($processId -eq $PID) { return }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
  if (-not $process) { return }
  $name = [string]$process.Name
  $commandLine = [string]$process.CommandLine
  if ($name -notmatch '^(node|npm|cmd|pwsh|powershell)\.exe$') { return }
  try {
    Stop-Process -Id $processId -Force -ErrorAction Stop
    $script:stopped += [pscustomobject]@{
      pid = $processId
      name = $name
      reason = $reason
      commandLine = $commandLine
    }
  } catch {}
}

$workspaceProcesses = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $cmd = [string]$_.CommandLine
  if (-not $cmd) {
    $false
  } else {
    $mentionsWorkspace = $cmd.Contains($workspace) -or $cmd.Contains($workspaceSlash) -or ($relativeToken -and $cmd.Contains($relativeToken))
    $isSmokeServer = $cmd -match 'dist[\\/]+cli\.js.*serve|npm.*start|node.*src[\\/]+dashboard\.js'
    $mentionsWorkspace -and $isSmokeServer
  }
}
foreach ($process in $workspaceProcesses) {
  Stop-ById -processId ([int]$process.ProcessId) -reason 'workspace command line'
}

if ($isDefault) {
  foreach ($port in @(4318, 4319, 4321)) {
    try {
      $owners = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
      foreach ($owner in $owners) {
        Stop-ById -processId ([int]$owner) -reason "default live smoke port $port"
      }
    } catch {}
  }
}

$stopped | ConvertTo-Json -Compress
`;
  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...process.env,
        SWARM_RESET_WORKSPACE: targetWorkspace,
        SWARM_RESET_RELATIVE_TOKEN: path.relative(repoRoot, targetWorkspace).replace(/\\/g, "/"),
        SWARM_RESET_DEFAULT: String(isDefaultWorkspace),
      },
    }).trim();
    if (!output) return [];
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function runSwarm(commandArgs) {
  return execFileSync(process.execPath, [cli, ...commandArgs], {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
}

function configureLiveSmokeProtocol(targetPath) {
  const protocolPath = path.join(targetPath, ".swarm", "protocol.yaml");
  const parsed = fs.existsSync(protocolPath)
    ? YAML.parse(fs.readFileSync(protocolPath, "utf8")) ?? {}
    : {};
  parsed.protocol ??= {};
  parsed.protocol.recovery ??= {};
  parsed.protocol.recovery.childIdleTimeoutSeconds = liveSmokeChildIdleTimeoutSeconds;
  fs.writeFileSync(protocolPath, YAML.stringify(parsed, { lineWidth: 0 }), "utf8");
}

function assertApprovedWorkspace(target) {
  const demoRoot = path.join(repoRoot, ".swarm-demo");
  const resolved = path.resolve(target);
  const relative = path.relative(demoRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to reset workspace outside approved live smoke root: ${demoRoot}`);
  }
  if (relative.includes(path.sep)) {
    throw new Error(`Refusing nested live smoke workspace reset: ${resolved}`);
  }
  const workspaceName = path.basename(resolved);
  const approvedName =
    samePath(resolved, defaultWorkspace) ||
    workspaceName.startsWith("live-agent-smoke-") ||
    workspaceName.startsWith("test-live-agent-");
  if (!approvedName) {
    throw new Error(
      `Refusing to reset unapproved live smoke workspace name: ${workspaceName}. Use live-agent-smoke, live-agent-smoke-*, or test-live-agent-* under ${demoRoot}.`,
    );
  }
  if (samePath(resolved, repoRoot) || samePath(resolved, path.dirname(repoRoot)) || samePath(resolved, demoRoot)) {
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
