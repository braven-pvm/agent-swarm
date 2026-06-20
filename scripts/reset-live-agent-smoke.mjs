#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const scenarioId = args.scenario ?? "live-agent-smoke";
const supportedScenarios = new Set(["live-agent-smoke", "live-agent-smoke-h2"]);
if (!supportedScenarios.has(scenarioId)) {
  throw new Error(`Unsupported live smoke scenario: ${scenarioId}. Expected ${[...supportedScenarios].join(", ")}.`);
}

const defaultWorkspaceName = scenarioId === "live-agent-smoke-h2" ? "live-agent-smoke-h2" : "live-agent-smoke";
const defaultWorkspace = path.join(repoRoot, ".swarm-demo", defaultWorkspaceName);
const workspace = path.resolve(args.workspace ?? defaultWorkspace);
const stopRelatedProcesses = args["stop-related-processes"] === "true";

assertApprovedWorkspace(workspace);

const cli = path.join(repoRoot, "dist", "cli.js");
const sourceSpecsDir = path.join(workspace, "source-specs");
const manifestPath = path.join(workspace, "live-agent-smoke.json");
const liveSmokeChildIdleTimeoutSeconds = 300;

const stoppedProcesses = stopRelatedProcesses ? stopRelatedProcessesForWorkspace(workspace) : [];
const summary = scenarioId === "live-agent-smoke-h2" ? resetSupportTriageScenario() : resetInvoiceScenario();

console.log(JSON.stringify(summary, null, 2));

function resetInvoiceScenario() {
  const invoiceTemplate = path.join(repoRoot, "fixtures", "templates", "invoice-api");
  const dashboardTemplate = path.join(repoRoot, "fixtures", "templates", "invoice-dashboard");
  const sourceProductSpec = path.join(repoRoot, "docs", "requirements", "live-smoke-invoice-dashboard-product-spec.md");

  const invoiceTarget = path.join(workspace, "invoice-api");
  const dashboardTarget = path.join(workspace, "invoice-dashboard");
  const productSpec = path.join(sourceSpecsDir, "live-smoke-invoice-dashboard-product-spec.md");

  resetWorkspace();
  fs.cpSync(invoiceTemplate, invoiceTarget, { recursive: true });
  fs.cpSync(dashboardTemplate, dashboardTarget, { recursive: true });
  fs.mkdirSync(sourceSpecsDir, { recursive: true });
  fs.copyFileSync(sourceProductSpec, productSpec);
  tryInitGit(invoiceTarget);
  tryInitGit(dashboardTarget);

  runSwarm(["init"]);
  runSwarm(["run-mode", "set", "live-agent-smoke"]);
  runSwarm(["target", "init", invoiceTarget]);
  runSwarm(["target", "init", dashboardTarget]);
  configureLiveSmokeProtocol(invoiceTarget);
  configureLiveSmokeProtocol(dashboardTarget);
  registerSource(productSpec, "Invoice Product", "product,full-stack,invoice-dashboard", 1);
  registerSource(path.join(invoiceTarget, "specs", "invoice-api.md"), "Invoice Backend", "backend,api,invoices,dashboard-enabler", 2);
  registerSource(path.join(dashboardTarget, "specs", "invoice-dashboard.md"), "Invoice Dashboard", "frontend,dashboard,invoices", 3);

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
      productSpec: toRepoPath(sourceProductSpec),
      maxSlices: 20,
      maxAgentRuns: 150,
      maxRuntimeMinutes: 120,
      maxTurns: 80,
      childIdleTimeoutSeconds: liveSmokeChildIdleTimeoutSeconds,
      productReadinessProbe: {
        ui: {
          path: "/",
          expectedText: ["Invoice Operations Dashboard", "Invoice dashboard"],
        },
        api: {
          path: "/api/summary",
          expectedJsonFields: ["invoiceCount", "openTotalCents"],
        },
        workflow: {
          kind: "invoice-mark-paid",
          summaryPath: "/api/summary",
          overduePath: "/api/invoices?status=overdue",
          updateStatusPathTemplate: "/api/invoices/:id/status",
        },
      },
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
    sources: manifestSources(snapshot),
    commands: invoiceCommands(),
  };

  return writeSummary({ snapshot, manifest, extra: { recovery: { childIdleTimeoutSeconds: liveSmokeChildIdleTimeoutSeconds } } });
}

function resetSupportTriageScenario() {
  const scenarioRoot = path.join(repoRoot, "fixtures", "scenarios", "support-triage");
  const scenarioContractPath = path.join(scenarioRoot, "scenario.json");
  const scenarioContract = readJsonFile(scenarioContractPath);
  const apiTemplate = path.join(repoRoot, "fixtures", "templates", "support-api");
  const uiTemplate = path.join(repoRoot, "fixtures", "templates", "support-ui");
  const apiTarget = path.join(workspace, "support-api");
  const uiTarget = path.join(workspace, "support-ui");

  resetWorkspace();
  fs.cpSync(apiTemplate, apiTarget, { recursive: true });
  fs.cpSync(uiTemplate, uiTarget, { recursive: true });
  fs.mkdirSync(sourceSpecsDir, { recursive: true });
  const copiedSources = copySupportTriageSources(scenarioContract);
  tryInitGit(apiTarget);
  tryInitGit(uiTarget);

  runSwarm(["init"]);
  runSwarm(["run-mode", "set", "live-agent-smoke"]);
  runSwarm(["target", "init", apiTarget]);
  runSwarm(["target", "init", uiTarget]);
  const apiSkillIds = copyScenarioSkills(scenarioRoot, apiTarget);
  const uiSkillIds = copyScenarioSkills(scenarioRoot, uiTarget);
  configureLiveSmokeProtocol(apiTarget, scenarioContract.skills, targetByName(scenarioContract, "support-api")?.skillHints);
  configureLiveSmokeProtocol(uiTarget, scenarioContract.skills, targetByName(scenarioContract, "support-ui")?.skillHints);
  for (const source of copiedSources) {
    registerSource(source.path, source.domain, source.tags, source.priority);
  }

  const snapshot = JSON.parse(runSwarm(["observe", "--events", "60"]));
  const manifest = {
    scenarioId: scenarioContract.scenarioId,
    runMode: "live-agent-smoke",
    phase: "phase-11b-scenario-reset-scaffold",
    generatedAt: new Date().toISOString(),
    workspace,
    scenarioContract: toRepoPath(scenarioContractPath),
    productSpec: copiedSources.find((source) => source.kind === "product")?.path,
    expectedOutcome: "support_triage_product_or_blocked_with_reasons",
    runnerStatus: "reset_scaffold_only",
    limits: {
      maxSlices: 24,
      maxAgentRuns: 180,
      maxRuntimeMinutes: 150,
    },
    fullProductMode: {
      plannedCommand: "swarm smoke live-agent full --scenario live-agent-smoke-h2",
      runnerStatus: "wired_phase_11d_real_run",
      productSpec: scenarioContract.product?.sources?.[0],
      maxSlices: 24,
      maxAgentRuns: 180,
      maxRuntimeMinutes: 150,
      maxTurns: 96,
      childIdleTimeoutSeconds: liveSmokeChildIdleTimeoutSeconds,
      productReadinessProbe: scenarioContract.productReadinessProbe,
    },
    targets: [
      buildSupportManifestTarget({
        contract: targetByName(scenarioContract, "support-api"),
        path: apiTarget,
        skillIds: apiSkillIds,
      }),
      buildSupportManifestTarget({
        contract: targetByName(scenarioContract, "support-ui"),
        path: uiTarget,
        skillIds: uiSkillIds,
      }),
    ],
    sources: manifestSources(snapshot),
    scenarioSources: copiedSources.map((source) => ({
      kind: source.kind,
      path: source.path,
      repoPath: source.repoPath,
      domain: source.domain,
      tags: source.tags,
      priority: source.priority,
    })),
    skills: scenarioContract.skills,
    commands: {
      serve: "node dist/cli.js serve --workspace .swarm-demo/live-agent-smoke-h2 --host 127.0.0.1 --port 4319",
      cliReset: "swarm smoke live-agent reset --scenario live-agent-smoke-h2",
      cliRun: "swarm smoke live-agent run --scenario live-agent-smoke-h2",
      cliFullProduct: "swarm smoke live-agent full --scenario live-agent-smoke-h2 --reset",
    },
  };

  return writeSummary({
    snapshot,
    manifest,
    extra: {
      scenarioContract: manifest.scenarioContract,
      runnerStatus: manifest.runnerStatus,
      recovery: { childIdleTimeoutSeconds: liveSmokeChildIdleTimeoutSeconds },
      skillIds: [...new Set([...apiSkillIds, ...uiSkillIds])].sort(),
    },
  });
}

function resetWorkspace() {
  const attempts = stopRelatedProcesses ? 8 : 1;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.mkdirSync(workspace, { recursive: true });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) sleepSync(250 * attempt);
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `Failed to reset live smoke workspace ${workspace}: ${message}. Stop any active swarm serve/product processes for this workspace or rerun with --stop-related-processes.`,
  );
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeSummary({ snapshot, manifest, extra = {} }) {
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return {
    scenarioId: manifest.scenarioId,
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
    sources: manifest.sources,
    ...extra,
  };
}

function registerSource(filePath, domain, tags, priority) {
  runSwarm([
    "sources",
    "add-file",
    filePath,
    "--domain",
    domain,
    "--tags",
    tags,
    "--priority",
    String(priority),
  ]);
}

function copySupportTriageSources(scenarioContract) {
  const sourceMetadata = {
    "live-smoke-support-triage-product-spec.md": {
      kind: "product",
      domain: "Support Product",
      tags: "support,product,smoke,full-product,human-verification",
      priority: 4,
    },
    "live-smoke-support-triage-api-requirements.md": {
      kind: "api",
      domain: "Support Backend",
      tags: "support,backend,api,smoke",
      priority: 1,
    },
    "live-smoke-support-triage-ui-requirements.md": {
      kind: "ui",
      domain: "Support Dashboard",
      tags: "support,frontend,ui,smoke,human-verification",
      priority: 3,
    },
    "live-smoke-support-triage-design-system.md": {
      kind: "design",
      domain: "Support Design System",
      tags: "support,frontend,design-system,accessibility,human-verification",
      priority: 2,
    },
  };
  const sources = scenarioContract.product?.sources;
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error("Support triage scenario must declare product.sources.");
  }
  return sources.map((repoRelativePath) => {
    const repoPath = path.join(repoRoot, repoRelativePath);
    const basename = path.basename(repoPath);
    const metadata = sourceMetadata[basename];
    if (!metadata) throw new Error(`No source metadata configured for ${basename}`);
    if (!fs.existsSync(repoPath)) throw new Error(`Support triage source does not exist: ${repoPath}`);
    const destination = path.join(sourceSpecsDir, basename);
    fs.copyFileSync(repoPath, destination);
    return {
      ...metadata,
      repoPath: repoRelativePath,
      path: destination,
    };
  });
}

function copyScenarioSkills(scenarioRoot, targetPath) {
  const sourceSkills = path.join(scenarioRoot, ".swarm", "skills");
  const targetSkills = path.join(targetPath, ".swarm", "skills");
  if (!fs.existsSync(sourceSkills)) return [];
  fs.rmSync(targetSkills, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetSkills), { recursive: true });
  fs.cpSync(sourceSkills, targetSkills, { recursive: true });
  return fs
    .readdirSync(targetSkills, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(targetSkills, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

function buildSupportManifestTarget({ contract, path: targetPath, skillIds }) {
  return {
    name: contract?.name ?? path.basename(targetPath),
    path: targetPath,
    role: contract?.role ?? "target",
    focus: contract?.focus ?? [],
    skillHints: contract?.skillHints ?? {},
    skillsCopied: skillIds,
    gitInitialized: tryGitStatus(targetPath),
  };
}

function targetByName(scenarioContract, name) {
  return (scenarioContract.targets ?? []).find((target) => target.name === name);
}

function manifestSources(snapshot) {
  return snapshot.sources.map((source) => ({
    id: source.id,
    title: source.title,
    uri: source.uri,
    hash: source.hash,
    domain: source.metadata?.domain ?? "Unassigned",
  }));
}

function invoiceCommands() {
  return {
    serve: "npm run demo:live-agent:serve",
    liveRun: "npm run demo:live-agent:run",
    scripted: "npm run demo:live-agent:scripted",
    fullProduct: "npm run demo:live-agent:full",
    resetAndFullProduct: "npm run smoke:live-agent:full",
    cliReset: "swarm smoke live-agent reset",
    cliRun: "swarm smoke live-agent run",
    cliFullProduct: "swarm smoke live-agent full",
  };
}

function stopRelatedProcessesForWorkspace(targetWorkspace) {
  if (process.platform !== "win32") return [];
  const isDefaultWorkspace = samePath(targetWorkspace, defaultWorkspace);
  const artifactPorts = collectWorkspacePorts(targetWorkspace);
  const excludePids = parseNumberList(process.env.SWARM_RESET_EXCLUDE_PIDS);
  const excludePorts = parseNumberList(process.env.SWARM_RESET_EXCLUDE_PORTS);
  const script = String.raw`
$workspace = $env:SWARM_RESET_WORKSPACE
$workspaceSlash = $workspace -replace '\\','/'
$relativeToken = $env:SWARM_RESET_RELATIVE_TOKEN
$isDefault = $env:SWARM_RESET_DEFAULT -eq 'true'
$artifactPorts = @($env:SWARM_RESET_PORTS -split ',' | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ })
$excludePids = @($env:SWARM_RESET_EXCLUDE_PIDS -split ',' | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ })
$excludePorts = @($env:SWARM_RESET_EXCLUDE_PORTS -split ',' | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ })
$stopped = @()

function Stop-ById([int]$processId, [string]$reason) {
  if ($processId -eq $PID) { return }
  if ($excludePids -contains $processId) { return }
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
    if ($excludePorts -contains $port) { continue }
    try {
      $owners = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
      foreach ($owner in $owners) {
        Stop-ById -processId ([int]$owner) -reason "default live smoke port $port"
      }
    } catch {}
  }
}

foreach ($port in $artifactPorts) {
  if ($excludePorts -contains $port) { continue }
  try {
    $owners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($owner in $owners) {
      Stop-ById -processId ([int]$owner) -reason "workspace artifact port $port"
    }
  } catch {}
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
        SWARM_RESET_PORTS: artifactPorts.join(","),
        SWARM_RESET_EXCLUDE_PIDS: excludePids.join(","),
        SWARM_RESET_EXCLUDE_PORTS: excludePorts.join(","),
      },
    }).trim();
    if (!output) return [];
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function parseNumberList(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isInteger(item) && item > 0);
}

function collectWorkspacePorts(targetWorkspace) {
  if (!fs.existsSync(targetWorkspace)) return [];
  const ports = new Set();
  const allowedExtensions = new Set([".json", ".txt", ".md", ".log"]);
  const stack = [targetWorkspace];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !allowedExtensions.has(path.extname(entry.name).toLowerCase())) continue;
      let content;
      try {
        const stats = fs.statSync(fullPath);
        if (stats.size > 5 * 1024 * 1024) continue;
        content = fs.readFileSync(fullPath, "utf8");
      } catch {
        continue;
      }
      const trustedProductArtifact = isTrustedProductPortArtifact(fullPath);
      for (const match of content.matchAll(/http:\/\/(?:127\.0\.0\.1|localhost):(\d{2,5})/gi)) {
        const port = Number.parseInt(match[1], 10);
        if (Number.isInteger(port) && port > 0 && port < 65536 && (trustedProductArtifact || isKnownSmokeProbePort(port))) ports.add(port);
      }
      for (const match of content.matchAll(/\bPORT[=\s:]+["']?(\d{2,5})/gi)) {
        const port = Number.parseInt(match[1], 10);
        if (Number.isInteger(port) && port > 0 && port < 65536 && (trustedProductArtifact || isKnownSmokeProbePort(port))) ports.add(port);
      }
    }
  }
  return [...ports].sort((left, right) => left - right);
}

function isTrustedProductPortArtifact(filePath) {
  const name = path.basename(filePath).toLowerCase();
  return [
    "live-agent-smoke.json",
    "live-agent-run-summary.json",
    "support-triage-live-summary.json",
    "product-readiness.json",
    "product-readiness.md",
    "product-probe.json",
    "product-probe.md",
    "product-start-output.txt",
  ].includes(name);
}

function isKnownSmokeProbePort(port) {
  return (port >= 4200 && port <= 4399) || (port >= 43100 && port <= 43199);
}

function runSwarm(commandArgs) {
  return execFileSync(process.execPath, [cli, ...commandArgs], {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
}

function configureLiveSmokeProtocol(targetPath, scenarioSkills, skillHints) {
  const protocolPath = path.join(targetPath, ".swarm", "protocol.yaml");
  const parsed = fs.existsSync(protocolPath)
    ? YAML.parse(fs.readFileSync(protocolPath, "utf8")) ?? {}
    : {};
  parsed.protocol ??= {};
  parsed.protocol.recovery ??= {};
  parsed.protocol.recovery.childIdleTimeoutSeconds = liveSmokeChildIdleTimeoutSeconds;
  if (scenarioSkills) {
    parsed.protocol.skills ??= {};
    parsed.protocol.skills.catalogs = scenarioSkills.catalogs ?? parsed.protocol.skills.catalogs ?? ["builtin", ".swarm/skills"];
    parsed.protocol.skills.roles ??= {};
    const scenarioRoles = { ...(scenarioSkills.roles ?? {}) };
    if (skillHints?.worker) {
      scenarioRoles.worker = { ...(scenarioRoles.worker ?? {}), optional: skillHints.worker };
    }
    if (skillHints?.reviewer) {
      scenarioRoles.reviewer = { ...(scenarioRoles.reviewer ?? {}), optional: skillHints.reviewer };
    }
    for (const [role, config] of Object.entries(scenarioRoles)) {
      parsed.protocol.skills.roles[role] ??= {};
      if (config.required) parsed.protocol.skills.roles[role].required = config.required;
      if (config.optional) parsed.protocol.skills.roles[role].optional = config.optional;
    }
  }
  if (skillHints) {
    parsed.protocol.scenario ??= {};
    parsed.protocol.scenario.skillHints = skillHints;
  }
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
      `Refusing to reset unapproved live smoke workspace name: ${workspaceName}. Use live-agent-smoke, live-agent-smoke-*, or test-live-agent-* under ${path.join(repoRoot, ".swarm-demo")}.`,
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

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function toRepoPath(filePath) {
  return path.relative(repoRoot, filePath).replace(/\\/g, "/");
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
