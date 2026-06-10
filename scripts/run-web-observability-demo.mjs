#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { SwarmStore } from "../dist/storage.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const driver = args.driver ?? "fixture";
if (!["fixture", "codex"].includes(driver)) {
  throw new Error(`Invalid --driver ${driver}; expected fixture or codex`);
}
const noReset = args["no-reset"] === "true";

const workspace = path.resolve(args.workspace ?? path.join(repoRoot, ".swarm-demo", "web-observability"));
const demoRoot = path.join(repoRoot, ".swarm-demo");
if (!workspace.toLowerCase().startsWith(demoRoot.toLowerCase())) {
  throw new Error(`Refusing to reset workspace outside ${demoRoot}: ${workspace}`);
}

const summaryPath = path.resolve(args.summary ?? path.join(workspace, "web-observability-summary.json"));
const artifactsDir = path.resolve(args.artifacts ?? path.join(workspace, "web-observability-artifacts"));
const cli = path.join(repoRoot, "dist", "cli.js");
const invoiceTemplate = path.join(repoRoot, "fixtures", "templates", "invoice-api");
const dashboardTemplate = path.join(repoRoot, "fixtures", "templates", "invoice-dashboard");
const invoiceTarget = path.join(workspace, "invoice-api");
const dashboardTarget = path.join(workspace, "invoice-dashboard");
const invoiceSpec = path.join(invoiceTarget, "specs", "invoice-api.md");
const dashboardSpec = path.join(dashboardTarget, "specs", "invoice-dashboard.md");
const opsSpec = path.join(workspace, "domain-specs", "release-ops.md");

resetWorkspace();
runSwarm(["init"]);
runSwarm(["run-mode", "set", driver === "fixture" ? "fixture" : "scripted-codex"]);
runSwarm(["target", "init", invoiceTarget]);
runSwarm(["target", "init", dashboardTarget]);
runSwarm(["sources", "add-file", invoiceSpec]);
runSwarm(["sources", "add-file", dashboardSpec]);
runSwarm(["sources", "add-file", opsSpec]);

let blockedDashboardOutput = "";
try {
  runSwarm([
    "slices",
    "pull",
    "--target",
    "invoice-dashboard",
    "--source",
    "invoice-dashboard.md",
    "--new-lane",
    "--lane-name",
    "Frontend Lane: Invoice Dashboard",
    "--lane-purpose",
    "Compose dashboard only after backend invoice capabilities are accepted",
    "--lane-labels",
    "frontend,invoice-dashboard,blocked-until-backend-ready",
    "--orchestrator",
    "planning-agent/frontend",
    "--batch-size",
    "3",
  ]);
} catch (error) {
  blockedDashboardOutput = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
}

const querySlice = pullSlice([
  "--target",
  "invoice-api",
  "--source",
  "invoice-api.md",
  "--new-lane",
  "--lane-name",
  "Backend Lane: Invoice Query Core",
  "--lane-purpose",
  "Implement verified invoice query capabilities needed before dashboard/UI work",
  "--lane-labels",
  "backend,invoice-api,query-core",
  "--orchestrator",
  "planning-agent/backend",
  "--batch-size",
  "3",
]);
runSwarm(["run", querySlice, "--actor", "backend-worker-query", "--driver", driver]);
runSwarm(["verify", querySlice, "--actor", "backend-verifier-query"]);

const summarySlice = pullSlice([
  "--target",
  "invoice-api",
  "--source",
  "invoice-api.md",
  "--new-lane",
  "--lane-name",
  "Backend Lane: Invoice Summary Cards",
  "--lane-purpose",
  "Implement verified aggregate capabilities that unblock dashboard cards",
  "--lane-labels",
  "backend,invoice-api,dashboard-enabler",
  "--orchestrator",
  "planning-agent/backend",
  "--batch-size",
  "2",
]);
runSwarm(["run", summarySlice, "--actor", "backend-worker-summary", "--driver", driver]);
runSwarm(["verify", summarySlice, "--actor", "backend-verifier-summary"]);

const lookupSlice = pullSlice([
  "--target",
  "invoice-api",
  "--source",
  "invoice-api.md",
  "--new-lane",
  "--lane-name",
  "Backend Lane: Invoice Lookup",
  "--lane-purpose",
  "Implement verified single-invoice lookup needed by detail views",
  "--lane-labels",
  "backend,invoice-api,lookup",
  "--orchestrator",
  "planning-agent/backend",
  "--batch-size",
  "2",
]);
runSwarm(["run", lookupSlice, "--actor", "backend-worker-lookup", "--driver", driver]);
runSwarm(["verify", lookupSlice, "--actor", "backend-verifier-lookup"]);

const dashboardSlice = pullSlice([
  "--target",
  "invoice-dashboard",
  "--source",
  "invoice-dashboard.md",
  "--new-lane",
  "--lane-name",
  "Frontend Lane: Invoice Dashboard",
  "--lane-purpose",
  "Compose dashboard only after backend invoice capabilities are accepted",
  "--lane-labels",
  "frontend,invoice-dashboard,backend-ready",
  "--orchestrator",
  "planning-agent/frontend",
  "--batch-size",
  "3",
]);
runSwarm(["run", dashboardSlice, "--actor", "frontend-worker-dashboard", "--driver", driver]);
runSwarm(["verify", dashboardSlice, "--actor", "frontend-verifier-dashboard"]);

const opsSlice = pullSlice([
  "--target",
  "invoice-api",
  "--source",
  "release-ops.md",
  "--new-lane",
  "--lane-name",
  "Ops Lane: Release Recovery",
  "--lane-purpose",
  "Exercise stale-run recovery and checkpoint visibility without blocking dashboard delivery",
  "--lane-labels",
  "ops,recovery,observability",
  "--orchestrator",
  "planning-agent/ops",
  "--batch-size",
  "2",
]);

const staleRunId = "RUN-webobs-stale";
const staleTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
const store = new SwarmStore(workspace);
try {
  store.insertAgentRun({
    id: staleRunId,
    sliceId: opsSlice,
    actor: "web-observability-stale-worker",
    driver: "fixture",
    status: "running",
    attempt: 1,
    startedAt: staleTimestamp,
    updatedAt: staleTimestamp,
  });
  store.upsertHeartbeat({
    id: "heartbeat:web-observability-stale-worker",
    actor: "web-observability-stale-worker",
    state: "thinking",
    detail: "Synthetic stale run for web observability E2E",
    entityType: "slice",
    entityId: opsSlice,
    timestamp: staleTimestamp,
  });
} finally {
  store.close();
}

const staleScan = runSwarm(["recovery", "scan", "--stale-after", "60"]);
runSwarm(["recovery", "scan", "--stale-after", "60", "--mark-stale"]);
const restartOutput = runSwarm(["recovery", "restart", staleRunId, "--driver", "fixture"]);

const finalSnapshot = JSON.parse(runSwarm(["observe", "--events", "180"]));
const graph = JSON.parse(runSwarm(["graph", "--format", "json"]));
const dashboardReport = runSwarm(["report", dashboardSlice]);
const opsTimeline = JSON.parse(runSwarm(["timeline", opsSlice, "--json"]));
const webProbe = await probeWebViewer({
  workspace,
  dashboardSlice,
  artifactsDir,
});

const acceptedBackendSlices = finalSnapshot.slices.filter(
  (slice) =>
    slice.targetId === finalSnapshot.targets.find((target) => target.name === "invoice-api")?.id &&
    slice.status === "accepted",
);
const acceptedDashboardSlice = finalSnapshot.slices.find((slice) => slice.id === dashboardSlice && slice.status === "accepted");
const domains = finalSnapshot.domains.map((domain) => domain.domain);

const summary = {
  workspace,
  driver,
  runMode: finalSnapshot.runMode,
  generatedAt: new Date().toISOString(),
  slices: {
    backend: [querySlice, summarySlice, lookupSlice],
    dashboard: dashboardSlice,
    ops: opsSlice,
  },
  staleRunId,
  blockedDashboardOutput,
  staleScan,
  restartOutput,
  counts: {
    targets: finalSnapshot.targets.length,
    sources: finalSnapshot.sources.length,
    domains: finalSnapshot.domains.length,
    lanes: finalSnapshot.lanes.length,
    slices: finalSnapshot.slices.length,
    agentRuns: finalSnapshot.agentRuns.length,
    checkpoints: finalSnapshot.checkpoints.length,
    activeEscalations: finalSnapshot.activeEscalations.length,
    graphNodes: graph.nodes.length,
    graphEdges: graph.edges.length,
    opsTimelineItems: opsTimeline.items.length,
  },
  lifecycleAssertions: {
    hasMultipleDomains:
      domains.includes("Invoice Backend") &&
      domains.includes("Invoice Dashboard") &&
      domains.includes("Release Operations"),
    dashboardBlockedBeforeBackend: blockedDashboardOutput.includes("Source dependencies are not satisfied"),
    backendAcceptedBeforeDashboard: acceptedBackendSlices.length >= 3 && Boolean(acceptedDashboardSlice),
    hasWorkerAndVerifierRuns:
      finalSnapshot.agentRuns.some((run) => run.actor === "backend-worker-summary" && run.status === "completed") &&
      finalSnapshot.heartbeats.some((heartbeat) => heartbeat.actor === "frontend-verifier-dashboard"),
    hasRecoveryPath:
      finalSnapshot.agentRuns.some((run) => run.id === staleRunId && run.status === "stale") &&
      finalSnapshot.agentRuns.some((run) => run.id !== staleRunId && run.sliceId === opsSlice && run.status === "completed") &&
      finalSnapshot.recentEvents.some((event) => event.type === "recovery.restart_completed"),
    hasVisibleBlocker: finalSnapshot.activeEscalations.some((item) => item.message.includes(staleRunId)),
    hasRoleCheckpoints:
      finalSnapshot.checkpoints.some((item) => item.role === "planner") &&
      finalSnapshot.checkpoints.some((item) => item.role === "worker") &&
      finalSnapshot.checkpoints.some((item) => item.role === "verifier") &&
      finalSnapshot.checkpoints.some((item) => item.role === "recovery"),
    reportShowsFrAcCoverage:
      dashboardReport.includes("FR/AC coverage:") &&
      dashboardReport.includes("AC-UI-INV-001.1: passed") &&
      dashboardReport.includes("command: Verification command passed"),
    graphConnectsLifecycle:
      graph.edges.some((edge) => edge.type === "dependency" && edge.from === "AC-INV-001.1" && edge.status === "satisfied") &&
      graph.edges.some((edge) => edge.type === "evidence" && edge.from === dashboardSlice) &&
      graph.nodes.some((node) => node.type === "domain" && node.label === "Invoice Dashboard"),
    timelineShowsRecovery: opsTimeline.items.some((item) => item.kind === "event" && item.label.includes("recovery.")),
  },
  webAssertions: webProbe.assertions,
  artifacts: {
    summary: summaryPath,
    ...webProbe.artifacts,
  },
};

fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify(summary, null, 2));

function resetWorkspace() {
  if (!noReset) {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  fs.mkdirSync(workspace, { recursive: true });
  fs.rmSync(invoiceTarget, { recursive: true, force: true });
  fs.rmSync(dashboardTarget, { recursive: true, force: true });
  fs.rmSync(path.dirname(opsSpec), { recursive: true, force: true });
  fs.cpSync(invoiceTemplate, invoiceTarget, { recursive: true });
  fs.cpSync(dashboardTemplate, dashboardTarget, { recursive: true });
  prependMetadata(invoiceSpec, ["Domain: Invoice Backend", "Tags: backend, invoices, dashboard-enabler", "Priority: 1"]);
  prependMetadata(dashboardSpec, ["Domain: Invoice Dashboard", "Tags: frontend, dashboard, invoices", "Priority: 2"]);
  fs.mkdirSync(path.dirname(opsSpec), { recursive: true });
  fs.writeFileSync(
    opsSpec,
    `# Release Operations Requirements

Domain: Release Operations
Tags: ops, recovery, observability
Priority: 3

## Recovery Visibility

- AC-OPS-001.1: Release observation snapshot records stale agent state.
- AC-OPS-001.2: Release observation snapshot records recovery restart state.

## Management Visibility

- FR-OPS-001: Release operators can inspect blockers, recovery events, and checkpoints from the harness viewer.
`,
    "utf8",
  );
}

function prependMetadata(filePath, lines) {
  const original = fs.readFileSync(filePath, "utf8");
  const [heading, ...rest] = original.split(/\r?\n/);
  fs.writeFileSync(filePath, `${heading}\n\n${lines.join("\n")}\n${rest.join("\n")}`, "utf8");
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

async function probeWebViewer(input) {
  fs.mkdirSync(input.artifactsDir, { recursive: true });
  const server = spawn(process.execPath, [
    cli,
    "serve",
    "--workspace",
    input.workspace,
    "--host",
    "127.0.0.1",
    "--port",
    "0",
    "--events",
    "180",
  ], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const port = await waitForServerPort(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const [html, appJs, snapshot, graph, search, report] = await Promise.all([
      fetchText(`${baseUrl}/`),
      fetchText(`${baseUrl}/assets/app.js`),
      fetchJson(`${baseUrl}/api/snapshot?events=180`),
      fetchJson(`${baseUrl}/api/graph`),
      fetchJson(`${baseUrl}/api/search/specs?q=AC-INV-002.1&domain=${encodeURIComponent("Invoice Backend")}&limit=8`),
      fetchText(`${baseUrl}/api/report/${encodeURIComponent(input.dashboardSlice)}`),
    ]);
    const dashboardSource = snapshot.sources.find((source) => source.title === "Invoice Dashboard Requirements");
    const sourceDetail = dashboardSource
      ? await fetchJson(`${baseUrl}/api/source/${encodeURIComponent(dashboardSource.id)}`)
      : undefined;
    const browserSmoke = await runBrowserSmoke({ appJs, baseUrl });

    const artifacts = {
      html: path.join(input.artifactsDir, "viewer.html"),
      appJs: path.join(input.artifactsDir, "app.js"),
      snapshot: path.join(input.artifactsDir, "api-snapshot.json"),
      graph: path.join(input.artifactsDir, "api-graph.json"),
      search: path.join(input.artifactsDir, "api-search-summary.json"),
      sourceDetail: path.join(input.artifactsDir, "api-source-dashboard.json"),
      report: path.join(input.artifactsDir, "dashboard-report.md"),
      browserSmoke: path.join(input.artifactsDir, "browser-smoke.json"),
    };
    fs.writeFileSync(artifacts.html, html, "utf8");
    fs.writeFileSync(artifacts.appJs, appJs, "utf8");
    fs.writeFileSync(artifacts.snapshot, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    fs.writeFileSync(artifacts.graph, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
    fs.writeFileSync(artifacts.search, `${JSON.stringify(search, null, 2)}\n`, "utf8");
    fs.writeFileSync(artifacts.sourceDetail, `${JSON.stringify(sourceDetail, null, 2)}\n`, "utf8");
    fs.writeFileSync(artifacts.report, report, "utf8");
    fs.writeFileSync(artifacts.browserSmoke, `${JSON.stringify(browserSmoke, null, 2)}\n`, "utf8");

    return {
      artifacts,
      assertions: {
        htmlHasTabs:
          html.includes('data-tab="overview"') &&
          html.includes('data-tab="specs"') &&
          html.includes('data-tab="work"') &&
          html.includes('data-tab="agents"') &&
          html.includes('data-tab="events"'),
        htmlHasRenderedDetailViews:
          html.includes('data-source-view="summary"') &&
          html.includes('data-source-view="sections"') &&
          html.includes('data-source-view="markdown"'),
        appJsCompiles: browserSmoke.appJsCompiles,
        browserSmokeTabsSwitch: browserSmoke.tabsSwitch,
        browserSmokeSourceViewSwitches: browserSmoke.sourceViewSwitches,
        browserSmokeSearchRuns: browserSmoke.searchRuns,
        apiSnapshotShowsLifecycle:
          snapshot.targets.length === 2 &&
          snapshot.sources.length === 3 &&
          snapshot.domains.length === 3 &&
          snapshot.slices.length >= 5 &&
          snapshot.agentRuns.length >= 6,
        apiSnapshotShowsRunMode: ["fixture", "scripted-codex"].includes(snapshot.runMode),
        apiSearchFindsBackendSummary:
          search.matches.some((match) => match.source.title === "Invoice Operations Backend Requirements") &&
          search.matches.some((match) => match.section.refs.includes("AC-INV-002.1")),
        apiSourceRendersDashboardMarkdown:
          Boolean(sourceDetail?.markdown?.includes("Invoice Dashboard Requirements")) &&
          Boolean(sourceDetail?.markdown?.includes("AC-UI-INV-001.1")),
        apiReportRendersDashboardCoverage:
          report.includes("# Slice Report:") &&
          report.includes("AC-UI-INV-001.1: passed") &&
          report.includes("command: Verification command passed"),
        apiGraphHasDomainAndEvidence:
          graph.nodes.some((node) => node.type === "domain" && node.label === "Invoice Backend") &&
          graph.edges.some((edge) => edge.type === "evidence" && edge.from === input.dashboardSlice),
      },
    };
  } finally {
    server.kill();
    await new Promise((resolve) => server.once("close", resolve));
  }
}

function waitForServerPort(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    let errorOutput = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out waiting for web viewer URL. stderr:\n${errorOutput}`));
    }, 5000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = /url: http:\/\/127\.0\.0\.1:(\d+)\//.exec(output);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });
    child.stderr.on("data", (chunk) => {
      errorOutput += chunk.toString();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      if (!/url: http:\/\/127\.0\.0\.1:(\d+)\//.test(output)) {
        clearTimeout(timeout);
        reject(new Error(`Web viewer exited before printing URL. code=${code} stderr:\n${errorOutput}`));
      }
    });
  });
}

async function runBrowserSmoke(input) {
  const document = createFakeDocument();
  const window = {
    setInterval: () => 1,
    clearInterval: () => {},
  };
  const relativeFetch = (url, init) => fetch(new URL(url, input.baseUrl), init);
  new Function("document", "window", "fetch", input.appJs)(document, window, relativeFetch);
  await waitFor(() => document.byId.metrics.innerHTML.includes("Targets"));

  document.tabs.find((tab) => tab.getAttribute("data-tab") === "specs").click();
  const tabsSwitch =
    document.panels.find((panel) => panel.id === "tab-specs").classList.contains("active") &&
    !document.panels.find((panel) => panel.id === "tab-overview").classList.contains("active");

  document.sourceViewButtons.find((button) => button.getAttribute("data-source-view") === "markdown").click();
  const sourceViewSwitches = document.sourceViewButtons
    .find((button) => button.getAttribute("data-source-view") === "markdown")
    .classList.contains("active");

  document.byId.specSearch.value = "summary";
  document.byId.specSearchButton.click();
  await waitFor(() => document.byId.specSearchStatus.textContent.includes('match(es) for "summary"'));
  const searchRuns =
    document.byId.specSearchStatus.textContent.includes("Invoice Backend") ||
    document.byId.specSearchStatus.textContent.includes("all specs");

  return {
    appJsCompiles: true,
    tabsSwitch,
    sourceViewSwitches,
    searchRuns,
    searchStatus: document.byId.specSearchStatus.textContent,
  };
}

function createFakeDocument() {
  const ids = [
    "workspace",
    "metrics",
    "domains",
    "domainCount",
    "lanes",
    "laneCount",
    "sources",
    "sourceCount",
    "specSearch",
    "specDomain",
    "specSearchButton",
    "specClearButton",
    "specSelectedOnly",
    "specSearchResults",
    "specSearchStatus",
    "sourceFilterLabel",
    "slices",
    "sliceCount",
    "agents",
    "agentCount",
    "heartbeats",
    "heartbeatCount",
    "blockers",
    "blockerCount",
    "events",
    "updatedAt",
    "report",
    "sourceDetail",
    "selectedSliceLabel",
    "selectedSourceLabel",
    "refresh",
    "autoRefresh",
  ];
  const byId = Object.fromEntries(ids.map((id) => [id, new FakeElement({ id })]));
  byId.autoRefresh.checked = true;
  const tabNames = ["overview", "specs", "work", "agents", "events"];
  const tabs = tabNames.map((name, index) => new FakeElement({
    attrs: { "data-tab": name },
    className: index === 0 ? "tab active" : "tab",
  }));
  const panels = tabNames.map((name, index) => new FakeElement({
    id: `tab-${name}`,
    className: index === 0 ? "tab-panel active" : "tab-panel",
  }));
  const sourceViewButtons = ["summary", "sections", "markdown"].map((name, index) => new FakeElement({
    attrs: { "data-source-view": name },
    className: index === 0 ? "detail-tab active" : "detail-tab",
  }));
  return {
    byId,
    tabs,
    panels,
    sourceViewButtons,
    getElementById(id) {
      return byId[id] ?? new FakeElement({ id });
    },
    querySelectorAll(selector) {
      if (selector === "[data-tab]") return tabs;
      if (selector === ".tab-panel") return panels;
      if (selector === "[data-source-view]") return sourceViewButtons;
      return [];
    },
  };
}

function FakeElement(input = {}) {
  this.id = input.id ?? "";
  this.attrs = input.attrs ?? {};
  this.classList = new FakeClassList(input.className ?? "");
  this.listeners = new Map();
  this.value = "";
  this.checked = false;
  this.innerHTML = "";
  this.textContent = "";
  this.getAttribute = (name) => this.attrs[name] ?? null;
  this.addEventListener = (type, callback) => {
    const current = this.listeners.get(type) ?? [];
    current.push(callback);
    this.listeners.set(type, current);
  };
  this.click = () => {
    for (const callback of this.listeners.get("click") ?? []) {
      callback({ type: "click", target: this });
    }
  };
  this.querySelectorAll = () => [];
}

FakeElement.prototype.getAttribute = function getAttribute(name) {
  return this.attrs[name] ?? null;
};

FakeElement.prototype.addEventListener = function addEventListener(type, callback) {
  const current = this.listeners.get(type) ?? [];
  current.push(callback);
  this.listeners.set(type, current);
};

FakeElement.prototype.click = function click() {
  for (const callback of this.listeners.get("click") ?? []) {
    callback({ type: "click", target: this });
  }
};

FakeElement.prototype.querySelectorAll = function querySelectorAll() {
  return [];
};

function FakeClassList(className) {
  this.values = new Set(String(className).split(/\s+/).filter(Boolean));
  this.add = (name) => {
    this.values.add(name);
  };
  this.remove = (name) => {
    this.values.delete(name);
  };
  this.toggle = (name, force) => {
    if (force === true) {
      this.add(name);
      return true;
    }
    if (force === false) {
      this.remove(name);
      return false;
    }
    if (this.values.has(name)) {
      this.values.delete(name);
      return false;
    }
    this.values.add(name);
    return true;
  };
  this.contains = (name) => this.values.has(name);
}

FakeClassList.prototype.add = function add(name) {
  this.values.add(name);
};

FakeClassList.prototype.remove = function remove(name) {
  this.values.delete(name);
};

FakeClassList.prototype.toggle = function toggle(name, force) {
  if (force === true) {
    this.add(name);
    return true;
  }
  if (force === false) {
    this.remove(name);
    return false;
  }
  if (this.values.has(name)) {
    this.values.delete(name);
    return false;
  }
  this.values.add(name);
  return true;
};

FakeClassList.prototype.contains = function contains(name) {
  return this.values.has(name);
};

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`);
  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`);
  return response.json();
}

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for browser smoke predicate");
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
