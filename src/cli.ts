#!/usr/bin/env node
import fs from "node:fs";
import http, { type ServerResponse } from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { URL } from "node:url";
import { Command } from "commander";
import YAML from "yaml";
import { createEvent } from "./events.js";
import { runFixtureWorker } from "./fixture-worker.js";
import { makeId } from "./ids.js";
import { artifactsDir, resolveWorkspace, swarmDir } from "./paths.js";
import { pullNextSlice } from "./planner.js";
import { overseerDecisionSchema, reviewResultSchema, workerResultSchema, type OverseerDecision, type ReviewResult } from "./schemas.js";
import { readSourceText, registerFileSource } from "./source-adapter.js";
import { SwarmStore } from "./storage.js";
import { initTarget } from "./target-init.js";
import { createWorkerJsonlIngestor, ingestWorkerJsonl } from "./worker-events.js";
import { loadProtocol } from "./protocol.js";
import { getWorkerDriver, workerDriverIds, resolveDriverCommand, type WorkerRunSpec, type WorkerFinalization } from "./worker-driver.js";
import { buildResumePacket, refreshCheckpoint } from "./checkpoints.js";
import { buildDomainDetail, buildDomainSummaries } from "./domains.js";
import { extractMarkdownSections, sourceDomain, sourceFrAcRefs, sourcePriority, sourceSections, sourceTags } from "./source-index.js";
import type { CheckpointRecord, CheckpointRole, EntityType, FrAcVerificationResult, HeartbeatState, RunMode, SliceRecord } from "./types.js";

const program = new Command();

const RUN_MODE_META_KEY = "run_mode";
const DEFAULT_RUN_MODE: RunMode = "unspecified";

type WorkerRunResult = {
  sliceId: string;
  runId: string;
  ok: boolean;
  exitCode: number | null;
  eventsPath: string;
  resultPath: string;
  workerEvents: ReturnType<typeof ingestWorkerJsonl>;
  stderr?: string;
};

type ReviewRunResult = {
  sliceId: string;
  runId: string;
  exitCode: number | null;
  eventsPath: string;
  resultPath: string;
  reviewerEvents: ReturnType<typeof ingestWorkerJsonl>;
  reviewResult?: ReviewResult;
  stderr?: string;
};

type OverseerRunResult = {
  scenario: string;
  runId: string;
  exitCode: number | null;
  eventsPath: string;
  resultPath: string;
  overseerEvents: ReturnType<typeof ingestWorkerJsonl>;
  commandResults?: OverseerCommandExecution[];
  decision?: OverseerDecision;
  stderr?: string;
};

type OverseerCommandExecution = {
  command: string;
  purpose: string;
  expectedStateChange: string;
  commandKey?: string;
  category?: "state" | "child_agent";
  childRole?: "worker" | "reviewer";
  sliceId?: string;
  status: "executed" | "blocked" | "failed";
  exitCode?: number | null;
  stdoutPath?: string;
  stderrPath?: string;
  reason?: string;
};

type OverseerCommandValidation =
  | {
      ok: true;
      cliArgs: string[];
      commandKey: string;
      category: "state" | "child_agent";
      childRole?: "worker" | "reviewer";
      sliceId?: string;
    }
  | { ok: false; reason: string };

type WorkerStreamingResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  workerEvents: ReturnType<typeof ingestWorkerJsonl>;
};

type ScenarioManifestLoad = {
  path: string;
  exists: boolean;
  data: Record<string, unknown>;
};

const WEB_VIEWER_HTML = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Agent Swarm Observability</title>
    <link rel="stylesheet" href="/assets/styles.css">
  </head>
  <body>
    <header class="topbar">
      <div>
        <h1>Agent Swarm Observability</h1>
        <p id="workspace">Loading workspace...</p>
      </div>
      <div class="toolbar">
        <button id="refresh" type="button">Refresh</button>
        <label>
          <span>Auto</span>
          <input id="autoRefresh" type="checkbox" checked>
        </label>
      </div>
    </header>

    <main>
      <section class="metrics" id="metrics"></section>

      <nav class="tabs" aria-label="Observability sections">
        <button class="tab active" type="button" data-tab="overview">Overview</button>
        <button class="tab" type="button" data-tab="specs">Specs</button>
        <button class="tab" type="button" data-tab="work">Work</button>
        <button class="tab" type="button" data-tab="agents">Agents</button>
        <button class="tab" type="button" data-tab="events">Events</button>
        <button class="tab" type="button" data-tab="history">History</button>
      </nav>

      <section id="tab-overview" class="tab-panel active">
        <section class="layout">
          <section class="panel wide">
            <div class="panel-title">
              <h2>Domain Readiness</h2>
              <span id="domainCount"></span>
            </div>
            <div id="domains" class="table-wrap"></div>
          </section>

          <section class="panel">
            <div class="panel-title">
              <h2>Blockers</h2>
              <span id="blockerCount"></span>
            </div>
            <div id="blockers" class="stack"></div>
          </section>
        </section>
      </section>

      <section id="tab-specs" class="tab-panel">
        <section class="split-layout">
          <section class="panel">
            <div class="panel-title">
              <h2>Specs</h2>
              <span id="sourceCount"></span>
            </div>
            <div class="spec-tools">
              <input id="specSearch" type="search" placeholder="Search specs, refs, sections">
              <select id="specDomain"></select>
              <button id="specSearchButton" type="button">Search</button>
              <button id="specClearButton" type="button">Clear</button>
            </div>
            <div class="spec-search-options">
              <label>
                <input id="specSelectedOnly" type="checkbox">
                <span>Selected spec only</span>
              </label>
              <span id="specSearchHint">Search spec sections by text or FR/AC ref. Results appear below.</span>
            </div>
            <div class="spec-subtitle">
              <strong>Search Results</strong>
              <span id="specSearchStatus">No search yet</span>
            </div>
            <div id="specSearchResults" class="stack compact"></div>
            <div class="spec-subtitle">
              <strong>Registered Specs</strong>
              <span id="sourceFilterLabel"></span>
            </div>
            <div id="sources" class="source-list"></div>
          </section>

          <section class="panel detail">
            <div class="panel-title">
              <h2>Spec Detail</h2>
              <span id="selectedSourceLabel"></span>
            </div>
            <div class="detail-tabs">
              <button class="detail-tab active" type="button" data-source-view="summary">Summary</button>
              <button class="detail-tab" type="button" data-source-view="sections">Sections</button>
              <button class="detail-tab" type="button" data-source-view="markdown">Markdown</button>
            </div>
            <div id="sourceDetail" class="rendered-detail muted">Select a spec to view its sections.</div>
          </section>
        </section>
      </section>

      <section id="tab-work" class="tab-panel">
        <section class="layout">
          <div class="column wide">
          <section class="panel">
            <div class="panel-title">
              <h2>Lanes</h2>
              <span id="laneCount"></span>
            </div>
            <div id="lanes" class="lane-list"></div>
          </section>

          <section class="panel">
            <div class="panel-title">
              <h2>Slices</h2>
              <span id="sliceCount"></span>
            </div>
            <div id="slices" class="slice-list"></div>
          </section>
          </div>

          <section class="panel detail">
            <div class="panel-title">
              <h2>Slice Detail</h2>
              <span id="selectedSliceLabel"></span>
            </div>
            <div id="report" class="rendered-detail markdown muted">Select a slice to view its report.</div>
          </section>
        </section>
      </section>

      <section id="tab-agents" class="tab-panel">
        <section class="layout">
          <section class="panel">
            <div class="panel-title">
              <h2>Agents</h2>
              <span id="agentCount"></span>
            </div>
            <div id="agents" class="table-wrap"></div>
          </section>

          <section class="panel detail">
            <div class="panel-title">
              <h2>Current Heartbeats</h2>
              <span id="heartbeatCount"></span>
            </div>
            <div id="heartbeats" class="table-wrap"></div>
          </section>
        </section>
      </section>

      <section id="tab-events" class="tab-panel">
        <section class="panel wide">
          <div class="panel-title">
            <h2>Recent Events</h2>
            <span id="updatedAt"></span>
          </div>
          <div id="events" class="event-list"></div>
        </section>
      </section>

      <section id="tab-history" class="tab-panel">
        <section class="layout">
          <section class="panel wide">
            <div class="panel-title">
              <h2>Run History</h2>
              <span id="historyRunCount"></span>
            </div>
            <div id="historyRuns" class="table-wrap"></div>
          </section>

          <section class="panel">
            <div class="panel-title">
              <h2>Latest Comparison</h2>
              <span id="historyComparisonLabel"></span>
            </div>
            <div id="historyComparison" class="stack"></div>
          </section>
        </section>

        <section class="panel wide">
          <div class="panel-title">
            <h2>Artifact Index</h2>
            <span id="historyArtifactLabel"></span>
          </div>
          <div id="historyArtifactIndex" class="rendered-detail">Select an archived run to inspect its artifact index.</div>
        </section>
      </section>
    </main>

    <script src="/assets/app.js"></script>
  </body>
</html>
`;

const WEB_VIEWER_CSS = String.raw`:root {
  color-scheme: light;
  --bg: #f6f7f4;
  --panel: #ffffff;
  --ink: #20231f;
  --muted: #626860;
  --line: #d9ded2;
  --green: #227a4d;
  --amber: #a45f08;
  --red: #b33b2e;
  --blue: #2f6690;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 20px 28px;
  border-bottom: 1px solid var(--line);
  background: #fbfcf8;
}

h1, h2, p {
  margin: 0;
}

h1 {
  font-size: 22px;
  font-weight: 700;
}

h2 {
  font-size: 15px;
  font-weight: 700;
}

#workspace,
.muted {
  color: var(--muted);
  font-size: 13px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 14px;
  white-space: nowrap;
}

button {
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #ffffff;
  color: var(--ink);
  padding: 7px 12px;
  font: inherit;
  cursor: pointer;
}

input,
select {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #ffffff;
  color: var(--ink);
  padding: 8px 10px;
  font: inherit;
  min-width: 0;
}

main {
  padding: 22px 28px 32px;
}

.tabs,
.detail-tabs {
  display: flex;
  gap: 6px;
  align-items: center;
}

.tabs {
  margin: 0 0 16px;
  border-bottom: 1px solid var(--line);
}

.tab,
.detail-tab {
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--muted);
  padding: 10px 12px;
  font-weight: 650;
}

.tab.active,
.detail-tab.active {
  color: var(--ink);
  box-shadow: inset 0 -3px 0 var(--blue);
}

.detail-tabs {
  padding: 9px 12px 0;
}

.detail-tab {
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 6px 10px;
}

.detail-tab.active {
  border-color: var(--blue);
  background: #eef6fb;
  box-shadow: none;
}

.tab-panel {
  display: none;
}

.tab-panel.active {
  display: block;
}

.metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
  margin-bottom: 18px;
}

.metric,
.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
}

.metric {
  padding: 13px 14px;
}

.metric strong {
  display: block;
  font-size: 24px;
}

.metric span {
  color: var(--muted);
  font-size: 12px;
}

.layout {
  display: grid;
  grid-template-columns: minmax(0, 1.55fr) minmax(340px, 0.9fr);
  gap: 16px;
  margin-bottom: 16px;
}

.split-layout {
  display: grid;
  grid-template-columns: minmax(420px, 1fr) minmax(440px, 0.9fr);
  gap: 16px;
  align-items: start;
}

.column {
  display: grid;
  gap: 16px;
  align-content: start;
}

.panel {
  min-width: 0;
  overflow: hidden;
}

.panel-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 13px 14px;
  border-bottom: 1px solid var(--line);
  background: #fbfcf8;
}

.panel-title span {
  color: var(--muted);
  font-size: 12px;
}

.lane-list,
.slice-list,
.source-list,
.stack,
.event-list,
.table-wrap {
  display: grid;
  gap: 10px;
  padding: 12px;
}

.spec-tools {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) minmax(140px, 220px) auto auto;
  gap: 8px;
  padding: 12px 12px 0;
}

.spec-search-options,
.spec-subtitle {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 8px 12px 0;
  color: var(--muted);
  font-size: 12px;
}

.spec-search-options label {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--ink);
  white-space: nowrap;
}

.spec-search-options input {
  width: auto;
}

.spec-subtitle strong {
  color: var(--ink);
  font-size: 12px;
}

.compact {
  padding-top: 8px;
  padding-bottom: 0;
}

.item {
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 10px;
  background: #ffffff;
}

.item.clickable {
  cursor: pointer;
}

.item.clickable:hover {
  border-color: var(--blue);
}

.item.selected {
  border-color: var(--blue);
  box-shadow: inset 3px 0 0 var(--blue);
}

.table-scroll {
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 7px;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.data-table th,
.data-table td {
  padding: 9px 10px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  vertical-align: top;
}

.data-table th {
  color: var(--muted);
  font-size: 11px;
  font-weight: 750;
  letter-spacing: 0;
  text-transform: uppercase;
  background: #fbfcf8;
  white-space: nowrap;
}

.data-table tr:last-child td {
  border-bottom: 0;
}

.data-table tr.clickable {
  cursor: pointer;
}

.data-table tr.clickable:hover td {
  background: #f5f9fc;
}

.data-table tr.selected td {
  background: #eef6fb;
}

.row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}

.title {
  font-weight: 700;
  overflow-wrap: anywhere;
}

.sub {
  margin-top: 4px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.pill {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 12px;
  font-weight: 650;
  border: 1px solid var(--line);
  white-space: nowrap;
}

.accepted,
.idle,
.satisfied,
.completed {
  color: var(--green);
  border-color: #a8d5bd;
  background: #edf8f1;
}

.implementing,
.verifying,
.thinking,
.reading,
.editing,
.testing,
.pending,
.running {
  color: var(--blue);
  border-color: #b8d2e6;
  background: #eef6fb;
}

.blocked,
.stale,
.failed,
.critical,
.human_required {
  color: var(--red);
  border-color: #e3b5ad;
  background: #fff1ee;
}

.warning,
.waiting {
  color: var(--amber);
  border-color: #e4c48d;
  background: #fff8e9;
}

.refs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.ref {
  border: 1px solid var(--line);
  border-radius: 5px;
  color: var(--muted);
  font-size: 11px;
  padding: 2px 5px;
}

.event-list .item {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}

.section-list {
  display: grid;
  gap: 6px;
  margin-top: 8px;
}

.section-row {
  border-left: 3px solid var(--line);
  padding-left: 8px;
}

.rendered-detail,
pre {
  margin: 0;
  padding: 14px;
  min-height: 280px;
  max-height: 620px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}

.rendered-detail {
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}

.detail-field {
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 9px 10px;
  background: #fbfcf8;
}

.detail-field span {
  display: block;
  color: var(--muted);
  font-size: 11px;
  font-weight: 750;
  text-transform: uppercase;
}

.detail-field strong {
  display: block;
  margin-top: 3px;
  overflow-wrap: anywhere;
}

.section-card {
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 10px;
  margin-top: 10px;
  background: #ffffff;
}

.markdown {
  color: var(--ink);
}

.markdown h1,
.markdown h2,
.markdown h3,
.markdown h4 {
  margin: 12px 0 6px;
  line-height: 1.25;
}

.markdown h1 {
  font-size: 20px;
}

.markdown h2 {
  font-size: 16px;
}

.markdown h3,
.markdown h4 {
  font-size: 14px;
}

.markdown p,
.markdown ul {
  margin: 7px 0;
}

.markdown ul {
  padding-left: 20px;
}

.markdown code,
.markdown pre {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}

.markdown code {
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 1px 4px;
  background: #f6f7f4;
}

.markdown pre {
  min-height: 0;
  max-height: none;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: #fbfcf8;
}

@media (max-width: 980px) {
  .topbar,
  .layout,
  .split-layout,
  .detail-grid {
    grid-template-columns: 1fr;
  }

  .topbar {
    display: grid;
  }

  .spec-tools {
    grid-template-columns: 1fr;
  }

  .spec-search-options,
  .spec-subtitle {
    align-items: flex-start;
    flex-direction: column;
  }
}
`;

const WEB_VIEWER_JS = String.raw`let snapshot = null;
let runHistory = { exists: false, runs: [] };
let selectedRunId = null;
let selectedRunDetail = null;
let latestRunComparison = null;
let selectedSliceId = null;
let selectedSourceId = null;
let selectedSourceDetail = null;
let sourceDetailView = "summary";
let timer = null;

const els = {
  workspace: document.getElementById("workspace"),
  metrics: document.getElementById("metrics"),
  tabs: Array.from(document.querySelectorAll("[data-tab]")),
  tabPanels: Array.from(document.querySelectorAll(".tab-panel")),
  domains: document.getElementById("domains"),
  domainCount: document.getElementById("domainCount"),
  lanes: document.getElementById("lanes"),
  laneCount: document.getElementById("laneCount"),
  sources: document.getElementById("sources"),
  sourceCount: document.getElementById("sourceCount"),
  specSearch: document.getElementById("specSearch"),
  specDomain: document.getElementById("specDomain"),
  specSearchButton: document.getElementById("specSearchButton"),
  specClearButton: document.getElementById("specClearButton"),
  specSelectedOnly: document.getElementById("specSelectedOnly"),
  specSearchResults: document.getElementById("specSearchResults"),
  specSearchStatus: document.getElementById("specSearchStatus"),
  sourceFilterLabel: document.getElementById("sourceFilterLabel"),
  slices: document.getElementById("slices"),
  sliceCount: document.getElementById("sliceCount"),
  agents: document.getElementById("agents"),
  agentCount: document.getElementById("agentCount"),
  heartbeats: document.getElementById("heartbeats"),
  heartbeatCount: document.getElementById("heartbeatCount"),
  blockers: document.getElementById("blockers"),
  blockerCount: document.getElementById("blockerCount"),
  events: document.getElementById("events"),
  updatedAt: document.getElementById("updatedAt"),
  historyRuns: document.getElementById("historyRuns"),
  historyRunCount: document.getElementById("historyRunCount"),
  historyComparison: document.getElementById("historyComparison"),
  historyComparisonLabel: document.getElementById("historyComparisonLabel"),
  historyArtifactIndex: document.getElementById("historyArtifactIndex"),
  historyArtifactLabel: document.getElementById("historyArtifactLabel"),
  report: document.getElementById("report"),
  sourceDetail: document.getElementById("sourceDetail"),
  selectedSliceLabel: document.getElementById("selectedSliceLabel"),
  selectedSourceLabel: document.getElementById("selectedSourceLabel"),
  sourceViewButtons: Array.from(document.querySelectorAll("[data-source-view]")),
  refresh: document.getElementById("refresh"),
  autoRefresh: document.getElementById("autoRefresh"),
};

els.tabs.forEach((button) => {
  button.addEventListener("click", () => activateTab(button.getAttribute("data-tab")));
});
els.sourceViewButtons.forEach((button) => {
  button.addEventListener("click", () => {
    sourceDetailView = button.getAttribute("data-source-view") || "summary";
    renderSourceDetailView();
  });
});
els.refresh.addEventListener("click", load);
els.specSearchButton.addEventListener("click", runSpecSearch);
els.specClearButton.addEventListener("click", clearSpecSearch);
els.specSearch.addEventListener("keydown", (event) => {
  if (event.key === "Enter") runSpecSearch();
});
els.specDomain.addEventListener("change", () => {
  renderSources();
  if (els.specSearch.value.trim()) runSpecSearch();
});
els.specSelectedOnly.addEventListener("change", () => {
  if (els.specSearch.value.trim()) runSpecSearch();
});
els.autoRefresh.addEventListener("change", () => {
  if (els.autoRefresh.checked) startTimer();
  else stopTimer();
});

startTimer();
load();

function startTimer() {
  stopTimer();
  timer = window.setInterval(load, 2000);
}

function stopTimer() {
  if (timer) window.clearInterval(timer);
  timer = null;
}

function activateTab(tabName) {
  els.tabs.forEach((button) => {
    button.classList.toggle("active", button.getAttribute("data-tab") === tabName);
  });
  els.tabPanels.forEach((panel) => {
    panel.classList.toggle("active", panel.id === "tab-" + tabName);
  });
}

async function load() {
  const [snapshotResponse, historyResponse] = await Promise.all([
    fetch("/api/snapshot?events=80", { cache: "no-store" }),
    fetch("/api/history/runs", { cache: "no-store" }),
  ]);
  snapshot = await snapshotResponse.json();
  runHistory = historyResponse.ok ? await historyResponse.json() : { exists: false, runs: [] };
  if (!selectedRunId && runHistory.runs && runHistory.runs.length > 0) selectedRunId = runHistory.runs[runHistory.runs.length - 1].runId;
  render();
  if (selectedSliceId) loadReport(selectedSliceId);
  if (selectedRunId) loadHistoryRun(selectedRunId);
  if (runHistory.runs && runHistory.runs.length >= 2) loadLatestRunComparison();
}

function render() {
  els.workspace.textContent = snapshot.workspace + " | mode: " + (snapshot.runMode || "unspecified");
  els.updatedAt.textContent = "Updated " + new Date(snapshot.generatedAt).toLocaleTimeString();
  const activeSlices = snapshot.slices.filter((slice) => !["accepted", "closed"].includes(slice.status));
  const runningAgents = snapshot.agentRuns.filter((run) => run.status === "running");
  const blockedDependencies = snapshot.dependencies.filter((dependency) => dependency.status === "blocked");
  renderMetrics([
    ["Run Mode", snapshot.runMode || "unspecified"],
    ["Targets", snapshot.targets.length],
    ["Sources", snapshot.sources.length],
    ["Domains", snapshot.domains ? snapshot.domains.length : 0],
    ["Lanes", snapshot.lanes.length],
    ["Slices", snapshot.slices.length],
    ["Active Work", activeSlices.length],
    ["Running Agents", runningAgents.length],
    ["Blockers", snapshot.activeEscalations.length + blockedDependencies.length],
    ["Archived Runs", runHistory.runs ? runHistory.runs.length : 0],
    ["Events", snapshot.recentEvents.length],
  ]);
  renderSpecDomainOptions();
  renderDomains();
  renderSources();
  renderLanes(activeSlices);
  renderSlices();
  renderAgents();
  renderHeartbeats();
  renderBlockers(blockedDependencies);
  renderEvents();
  renderHistory();
}

function renderMetrics(items) {
  els.metrics.innerHTML = items.map(([label, value]) =>
    '<div class="metric"><strong>' + escapeHtml(value) + '</strong><span>' + escapeHtml(label) + '</span></div>'
  ).join("");
}

function renderDomains() {
  const domains = (snapshot.domains || []).slice().sort((a, b) => a.domain.localeCompare(b.domain));
  els.domainCount.textContent = domains.length + " domains";
  els.domains.innerHTML = tableHtml(
    ["Domain", "Sources", "Refs", "Available", "Active", "Blocked", "Completed", "Tags"],
    domains.map((domain) => [
      '<strong>' + escapeHtml(domain.domain) + '</strong>',
      escapeHtml(domain.sources),
      escapeHtml(domain.refs),
      escapeHtml(domain.available),
      escapeHtml(domain.active),
      escapeHtml(domain.blocked),
      escapeHtml(domain.completed),
      escapeHtml((domain.tags || []).join(", ") || "none"),
    ]),
    "No domains indexed",
  );
}

function renderSpecDomainOptions() {
  const current = els.specDomain.value;
  const domains = (snapshot.domains || []).map((domain) => domain.domain).sort();
  els.specDomain.innerHTML = '<option value="">All domains</option>' + domains.map((domain) =>
    '<option value="' + escapeHtml(domain) + '">' + escapeHtml(domain) + '</option>'
  ).join("");
  if (domains.includes(current)) els.specDomain.value = current;
}

function renderSources() {
  const selectedDomain = els.specDomain.value;
  const sources = snapshot.sources
    .filter((source) => !selectedDomain || sourceDomain(source) === selectedDomain)
    .sort((a, b) => sourcePriority(a) - sourcePriority(b) || source.title.localeCompare(b.title));
  els.sourceCount.textContent = sources.length + " shown";
  els.sourceFilterLabel.textContent = selectedDomain ? "domain: " + selectedDomain : "all domains";
  els.sources.innerHTML = tableHtml(
    ["Spec", "Domain", "Refs", "Sections", "Priority", "Tags", "State"],
    sources.map((source) => {
    const refs = sourceRefs(source);
    const sections = sourceSections(source);
    const domain = sourceDomain(source);
    const tags = sourceTags(source);
    const domainSummary = (snapshot.domains || []).find((item) => item.domain === domain);
    const status = domainSummary
      ? 'available ' + domainSummary.available + ' | active ' + domainSummary.active + ' | completed ' + domainSummary.completed
      : 'indexed';
    return {
      attrs: 'class="clickable ' + (source.id === selectedSourceId ? 'selected' : '') + '" data-source="' + escapeHtml(source.id) + '"',
      cells: [
        '<strong>' + escapeHtml(source.title) + '</strong><div class="sub">' + escapeHtml(source.id) + '</div>',
        escapeHtml(domain),
        refsHtml(refs.slice(0, 6)) || escapeHtml(refs.length),
        escapeHtml(sections.length),
        escapeHtml(sourcePriority(source)),
        escapeHtml(tags.join(", ") || "none"),
        pill(status),
      ],
    };
  }),
    "No specs registered",
  );
  els.sources.querySelectorAll("[data-source]").forEach((node) => {
    node.addEventListener("click", () => {
      selectedSourceId = node.getAttribute("data-source");
      renderSourceDetail(selectedSourceId);
      renderSources();
      if (els.specSelectedOnly.checked && els.specSearch.value.trim()) runSpecSearch();
    });
  });
  if (selectedSourceId && sources.some((source) => source.id === selectedSourceId)) renderSourceDetail(selectedSourceId);
}

async function renderSourceDetail(sourceId) {
  const source = snapshot.sources.find((item) => item.id === sourceId);
  if (!source) return;
  selectedSourceId = sourceId;
  els.selectedSourceLabel.textContent = source.id;
  els.sourceDetail.innerHTML = '<div class="muted">Loading source detail...</div>';
  const response = await fetch("/api/source/" + encodeURIComponent(sourceId), { cache: "no-store" });
  selectedSourceDetail = response.ok ? await response.json() : { source, markdown: "" };
  renderSourceDetailView();
}

function renderSourceDetailView() {
  els.sourceViewButtons.forEach((button) => {
    button.classList.toggle("active", button.getAttribute("data-source-view") === sourceDetailView);
  });
  if (!selectedSourceId || !selectedSourceDetail) {
    els.sourceDetail.innerHTML = '<div class="muted">Select a spec to view its sections.</div>';
    return;
  }
  const source = selectedSourceDetail.source;
  const refs = sourceRefs(source);
  const sections = sourceSections(source);
  if (sourceDetailView === "markdown") {
    els.sourceDetail.classList.add("markdown");
    els.sourceDetail.innerHTML = renderMarkdown(selectedSourceDetail.markdown || "# " + source.title);
    return;
  }
  els.sourceDetail.classList.remove("markdown");
  if (sourceDetailView === "sections") {
    els.sourceDetail.innerHTML = emptyOr(sections.map((section) =>
      '<article class="section-card">' +
      '<div class="row"><div><div class="title">' + escapeHtml(section.title) + '</div>' +
      '<div class="sub">lines ' + section.startLine + '-' + section.endLine + '</div></div>' +
      (section.refs.length ? '<span class="pill">' + section.refs.length + ' refs</span>' : '<span class="pill">no refs</span>') +
      '</div>' +
      refsHtml(section.refs) +
      '<div class="sub">' + escapeHtml(section.snippet || "No snippet indexed") + '</div>' +
      '</article>'
    ), "No sections indexed");
    return;
  }
  els.sourceDetail.innerHTML =
    '<div class="detail-grid">' +
    detailField("Title", source.title) +
    detailField("Domain", sourceDomain(source)) +
    detailField("Priority", sourcePriority(source)) +
    detailField("Tags", sourceTags(source).join(", ") || "none") +
    detailField("Refs", refs.length) +
    detailField("Sections", sections.length) +
    detailField("Hash", source.hash) +
    detailField("URI", source.uri) +
    '</div>' +
    '<h3>FR/AC References</h3>' +
    (refsHtml(refs) || '<p class="muted">No FR/AC references indexed.</p>') +
    '<h3>Section Overview</h3>' +
    tableHtml(
      ["Section", "Lines", "Refs"],
      sections.map((section) => [
        '<strong>' + escapeHtml(section.title) + '</strong>',
        escapeHtml(section.startLine + "-" + section.endLine),
        refsHtml(section.refs) || "none",
      ]),
      "No sections indexed",
    );
}

function clearSpecSearch() {
  els.specSearch.value = "";
  els.specSearchResults.innerHTML = "";
  els.specSearchStatus.textContent = "Search cleared";
}

async function runSpecSearch() {
  const query = els.specSearch.value.trim();
  if (!query) {
    els.specSearchResults.innerHTML = "";
    els.specSearchStatus.textContent = "Enter a search term";
    return;
  }
  if (els.specSelectedOnly.checked && !selectedSourceId) {
    els.specSearchResults.innerHTML = "";
    els.specSearchStatus.textContent = "Select a spec before using selected-spec search";
    return;
  }
  const params = new URLSearchParams({ q: query, limit: "8" });
  if (els.specDomain.value) params.set("domain", els.specDomain.value);
  if (els.specSelectedOnly.checked && selectedSourceId) params.set("source", selectedSourceId);
  els.specSearchStatus.textContent = "Searching...";
  const response = await fetch("/api/search/specs?" + params.toString(), { cache: "no-store" });
  const result = await response.json();
  const scope = result.source ? " in " + result.source.title : (els.specDomain.value ? " in " + els.specDomain.value : " across all specs");
  els.specSearchStatus.textContent = result.matches.length + " match(es) for \"" + result.query + "\"" + scope;
  els.specSearchResults.innerHTML = emptyOr(result.matches.map((match) =>
    '<article class="item clickable" data-search-source="' + escapeHtml(match.source.id) + '">' +
    '<div class="title">' + escapeHtml(match.source.title + " > " + match.section.title) + '</div>' +
    '<div class="sub">domain: ' + escapeHtml(match.source.domain) + ' | lines ' + match.section.startLine + '-' + match.section.endLine + ' | score ' + match.score + '</div>' +
    refsHtml(match.section.refs) +
    '<div class="sub">' + escapeHtml(match.snippet) + '</div>' +
    '</article>'
  ), "No spec matches");
  els.specSearchResults.querySelectorAll("[data-search-source]").forEach((node) => {
    node.addEventListener("click", () => {
      selectedSourceId = node.getAttribute("data-search-source");
      renderSourceDetail(selectedSourceId);
      renderSources();
    });
  });
}

function renderLanes(activeSlices) {
  els.laneCount.textContent = snapshot.lanes.length + " total";
  els.lanes.innerHTML = tableHtml(["Lane", "State", "Orchestrator", "Active", "Focus", "Refs"], snapshot.lanes.map((lane) => {
    const laneSlices = snapshot.slices.filter((slice) => slice.laneId === lane.id);
    const active = activeSlices.filter((slice) => slice.laneId === lane.id);
    const refs = unique(laneSlices.flatMap((slice) => slice.frAcRefs));
    return [
      '<strong>' + escapeHtml(lane.name) + '</strong><div class="sub">' + escapeHtml(lane.purpose) + '</div>',
      pill(lane.state),
      escapeHtml(lane.orchestrator),
      escapeHtml(active.length),
      escapeHtml(lane.focusLabels.join(", ") || "none"),
      refsHtml(refs.slice(0, 10)) || "none",
    ];
  }), "No lanes");
}

function renderSlices() {
  els.sliceCount.textContent = snapshot.slices.length + " total";
  els.slices.innerHTML = tableHtml(["Slice", "Status", "Lane", "Refs", "Evidence", "Agents"], snapshot.slices.slice().reverse().map((slice) => {
    const lane = snapshot.lanes.find((item) => item.id === slice.laneId);
    const evidenceCount = slice.evidence ? slice.evidence.length : 0;
    return {
      attrs: 'class="clickable ' + (slice.id === selectedSliceId ? 'selected' : '') + '" data-slice="' + escapeHtml(slice.id) + '"',
      cells: [
        '<strong>' + escapeHtml(slice.title) + '</strong><div class="sub">' + escapeHtml(slice.id) + '</div>',
        pill(slice.status),
        escapeHtml(lane ? lane.name : slice.laneId),
        refsHtml(slice.frAcRefs) || "none",
        escapeHtml(evidenceCount),
        escapeHtml(slice.agentRuns ? slice.agentRuns.length : 0),
      ],
    };
  }), "No slices");
  els.slices.querySelectorAll("[data-slice]").forEach((node) => {
    node.addEventListener("click", () => {
      selectedSliceId = node.getAttribute("data-slice");
      loadReport(selectedSliceId);
      renderSlices();
    });
  });
}

function renderAgents() {
  els.agentCount.textContent = snapshot.agentRuns.length + " runs";
  const heartbeats = new Map(snapshot.heartbeats.map((heartbeat) => [heartbeat.actor + ":" + heartbeat.entityId, heartbeat]));
  els.agents.innerHTML = tableHtml(["Agent", "Role", "Status", "Entity", "Driver", "Attempt", "Heartbeat", "Session"], snapshot.agentRuns.slice().reverse().slice(0, 30).map((run) => {
    const entityId = run.entityId || run.sliceId;
    const heartbeat = heartbeats.get(run.actor + ":" + entityId);
    return [
      '<strong>' + escapeHtml(run.actor) + '</strong><div class="sub">' + escapeHtml(run.id) + '</div>',
      escapeHtml(run.role || "agent"),
      pill(run.status),
      escapeHtml((run.entityType || "slice") + ":" + entityId),
      escapeHtml(run.driver),
      escapeHtml(run.attempt),
      heartbeat ? pill(heartbeat.state) + '<div class="sub">' + escapeHtml(heartbeat.detail || "") + '</div>' : '<span class="muted">none</span>',
      escapeHtml(run.sessionId || "none"),
    ];
  }), "No agent runs");
}

function renderHeartbeats() {
  els.heartbeatCount.textContent = snapshot.heartbeats.length + " current";
  els.heartbeats.innerHTML = tableHtml(["Actor", "State", "Entity", "Detail", "Updated"], snapshot.heartbeats.map((heartbeat) => [
    '<strong>' + escapeHtml(heartbeat.actor) + '</strong>',
    pill(heartbeat.state),
    escapeHtml((heartbeat.entityType || "entity") + ":" + (heartbeat.entityId || "-")),
    escapeHtml(heartbeat.detail || ""),
    escapeHtml(new Date(heartbeat.timestamp).toLocaleTimeString()),
  ]), "No heartbeats");
}

function renderBlockers(blockedDependencies) {
  const items = [];
  snapshot.activeEscalations.forEach((escalation) => {
    items.push('<article class="item"><div class="row"><div class="title">' + escapeHtml(escalation.entityType + ":" + escalation.entityId) + '</div>' + pill(escalation.level) + '</div><div class="sub">' + escapeHtml(escalation.message) + '</div></article>');
  });
  blockedDependencies.forEach((dependency) => {
    items.push('<article class="item"><div class="row"><div class="title">' + escapeHtml(dependency.target) + '</div>' + pill(dependency.status) + '</div><div class="sub">' + escapeHtml(dependency.reason) + '</div></article>');
  });
  els.blockerCount.textContent = items.length + " active";
  els.blockers.innerHTML = emptyOr(items, "No blockers");
}

function renderEvents() {
  els.events.innerHTML = tableHtml(["Time", "Actor", "Type", "Entity"], snapshot.recentEvents.map((event) => [
    escapeHtml(new Date(event.timestamp).toLocaleTimeString()),
    '<strong>' + escapeHtml(event.actor) + '</strong>',
    escapeHtml(event.type),
    escapeHtml(event.entityType + ":" + event.entityId),
  ]), "No events");
}

function renderHistory() {
  const runs = runHistory.runs || [];
  if (selectedRunId && !runs.some((run) => run.runId === selectedRunId)) {
    selectedRunId = runs.length > 0 ? runs[runs.length - 1].runId : null;
    selectedRunDetail = null;
  }
  els.historyRunCount.textContent = runHistory.exists ? runs.length + " archived" : "no history";
  if (!runHistory.exists) {
    els.historyRuns.innerHTML = '<div class="item muted">No live run history found. Run the live smoke once to create history.</div>';
    els.historyComparison.innerHTML = '<div class="item muted">Need at least two archived runs for comparison.</div>';
    els.historyComparisonLabel.textContent = "";
    return;
  }
  els.historyRuns.innerHTML = tableHtml(
    ["Run", "Generated", "Fault", "Outcome", "Classifier", "Turns", "Agents", "Verify", "Escalations"],
    runs.slice().reverse().map((run) => ({
      attrs: 'class="clickable ' + (run.runId === selectedRunId ? 'selected' : '') + '" data-run="' + escapeHtml(run.runId) + '"',
      cells: [
        '<strong>' + escapeHtml(run.runId) + '</strong><div class="sub">' + escapeHtml(run.phase || "") + '</div>',
        escapeHtml(run.generatedAt ? new Date(run.generatedAt).toLocaleString() : "unknown"),
        escapeHtml(run.faultMode || "none"),
        pill(run.finalOutcome || "unknown"),
        pill(run.classificationCode || "unknown"),
        escapeHtml(run.counts ? run.counts.turns : 0),
        escapeHtml(run.counts ? run.counts.agentRuns : 0),
        escapeHtml(run.counts ? run.counts.verifyRuns : 0),
        escapeHtml(run.counts ? run.counts.activeEscalations : 0),
      ],
    })),
    "No archived live runs",
  );
  if (runs.length < 2) {
    latestRunComparison = null;
    els.historyComparisonLabel.textContent = "";
    els.historyComparison.innerHTML = '<div class="item muted">Need at least two archived runs for comparison.</div>';
  }
  els.historyRuns.querySelectorAll("[data-run]").forEach((node) => {
    node.addEventListener("click", () => {
      selectedRunId = node.getAttribute("data-run");
      renderHistory();
      loadHistoryRun(selectedRunId);
    });
  });
}

async function loadHistoryRun(runId) {
  const response = await fetch("/api/history/run/" + encodeURIComponent(runId), { cache: "no-store" });
  selectedRunDetail = response.ok ? await response.json() : null;
  renderHistoryArtifactIndex();
}

async function loadLatestRunComparison() {
  const response = await fetch("/api/history/compare", { cache: "no-store" });
  latestRunComparison = response.ok ? await response.json() : null;
  renderHistoryComparison();
}

function renderHistoryComparison() {
  if (!latestRunComparison) {
    els.historyComparisonLabel.textContent = "";
    els.historyComparison.innerHTML = '<div class="item muted">Need at least two archived runs for comparison.</div>';
    return;
  }
  els.historyComparisonLabel.textContent = latestRunComparison.left.runId + " -> " + latestRunComparison.right.runId;
  els.historyComparison.innerHTML =
    '<article class="item">' +
    '<div class="title">' + escapeHtml(latestRunComparison.deltas.finalOutcome) + '</div>' +
    '<div class="sub">classification: ' + escapeHtml(latestRunComparison.deltas.classification) + '</div>' +
    '<div class="sub">fault: ' + escapeHtml(latestRunComparison.deltas.faultMode) + '</div>' +
    '<div class="sub">' + escapeHtml(latestRunComparison.interpretation) + '</div>' +
    '</article>' +
    tableHtml(
      ["Metric", "Delta"],
      Object.entries(latestRunComparison.deltas.counts).map(([key, value]) => [escapeHtml(key), escapeHtml(value)]),
      "No deltas",
    );
}

function renderHistoryArtifactIndex() {
  if (!selectedRunDetail) {
    els.historyArtifactLabel.textContent = "";
    els.historyArtifactIndex.innerHTML = '<div class="muted">Select an archived run to inspect its artifact index.</div>';
    return;
  }
  const summary = selectedRunDetail.summary;
  const index = selectedRunDetail.artifactIndex;
  els.historyArtifactLabel.textContent = summary.runId;
  const items = index && Array.isArray(index.items) ? index.items : [];
  els.historyArtifactIndex.innerHTML =
    '<div class="detail-grid">' +
    detailField("Run", summary.runId) +
    detailField("Outcome", summary.finalOutcome) +
    detailField("Classifier", summary.outcomeClassification ? summary.outcomeClassification.code : "unknown") +
    detailField("Fault", summary.fault ? summary.fault.mode : "unknown") +
    detailField("Turns", summary.counts ? summary.counts.turns : 0) +
    detailField("Agent Runs", summary.counts ? summary.counts.agentRuns : 0) +
    '</div>' +
    '<h3>Classifier</h3>' +
    '<p>' + escapeHtml(summary.outcomeClassification ? summary.outcomeClassification.explanation : "No classifier explanation.") + '</p>' +
    '<h3>Indexed Artifacts</h3>' +
    tableHtml(
      ["Category", "Key", "Exists", "Path"],
      items.map((item) => [
        escapeHtml(item.category),
        '<strong>' + escapeHtml(item.key) + '</strong><div class="sub">' + escapeHtml(item.description || "") + '</div>',
        item.exists ? pill("yes") : pill("missing"),
        escapeHtml(item.path),
      ]),
      "No artifact index items",
    );
}

async function loadReport(sliceId) {
  els.selectedSliceLabel.textContent = sliceId;
  const response = await fetch("/api/report/" + encodeURIComponent(sliceId), { cache: "no-store" });
  const markdown = await response.text();
  els.report.classList.remove("muted");
  els.report.innerHTML = renderMarkdown(markdown);
}

function pill(value) {
  return '<span class="pill ' + escapeHtml(String(value)) + '">' + escapeHtml(String(value)) + '</span>';
}

function refsHtml(refs) {
  if (!refs || refs.length === 0) return "";
  return '<div class="refs">' + refs.map((ref) => '<span class="ref">' + escapeHtml(ref) + '</span>').join("") + '</div>';
}

function emptyOr(items, emptyText) {
  return items.length ? items.join("") : '<div class="item muted">' + escapeHtml(emptyText) + '</div>';
}

function tableHtml(headers, rows, emptyText) {
  if (!rows || rows.length === 0) return '<div class="item muted">' + escapeHtml(emptyText) + '</div>';
  return '<div class="table-scroll"><table class="data-table"><thead><tr>' +
    headers.map((header) => '<th>' + escapeHtml(header) + '</th>').join("") +
    '</tr></thead><tbody>' +
    rows.map((row) => {
      const cells = Array.isArray(row) ? row : row.cells;
      const attrs = Array.isArray(row) ? "" : " " + row.attrs;
      return '<tr' + attrs + '>' + cells.map((cell) => '<td>' + cell + '</td>').join("") + '</tr>';
    }).join("") +
    '</tbody></table></div>';
}

function detailField(label, value) {
  return '<div class="detail-field"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong></div>';
}

function renderMarkdown(markdown) {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const html = [];
  const fence = String.fromCharCode(96, 96, 96);
  let inList = false;
  let inCode = false;
  let codeLines = [];
  const closeList = () => {
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
  };
  const closeCode = () => {
    if (inCode) {
      html.push("<pre><code>" + escapeHtml(codeLines.join("\n")) + "</code></pre>");
      codeLines = [];
      inCode = false;
    }
  };
  for (const line of lines) {
    if (line.trim().startsWith(fence)) {
      if (inCode) closeCode();
      else {
        closeList();
        inCode = true;
        codeLines = [];
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html.push("<h" + level + ">" + inlineMarkdown(heading[2]) + "</h" + level + ">");
      continue;
    }
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push("<li>" + inlineMarkdown(bullet[1]) + "</li>");
      continue;
    }
    if (!line.trim()) {
      closeList();
      continue;
    }
    closeList();
    html.push("<p>" + inlineMarkdown(line) + "</p>");
  }
  closeList();
  closeCode();
  return '<div class="markdown">' + html.join("") + '</div>';
}

function inlineMarkdown(value) {
  const tick = String.fromCharCode(96);
  const inlineCodePattern = new RegExp(tick + "([^" + tick + "]+)" + tick, "g");
  return escapeHtml(value)
    .replace(inlineCodePattern, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function unique(values) {
  return Array.from(new Set(values));
}

function sourceDomain(source) {
  return source.metadata && source.metadata.domain ? String(source.metadata.domain) : "Unassigned";
}

function sourceTags(source) {
  return source.metadata && Array.isArray(source.metadata.tags) ? source.metadata.tags.map(String) : [];
}

function sourcePriority(source) {
  return source.metadata && Number.isFinite(source.metadata.priority) ? Number(source.metadata.priority) : 100;
}

function sourceRefs(source) {
  return source.metadata && Array.isArray(source.metadata.frAcRefs) ? source.metadata.frAcRefs.map(String) : [];
}

function sourceSections(source) {
  return source.metadata && Array.isArray(source.metadata.sections) ? source.metadata.sections : [];
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}
`;

program
  .name("swarm")
  .description("Agent swarm harness prototype")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize local harness state")
  .option("--force", "reserved for future destructive reinitialization")
  .action((options: { force?: boolean }) => {
    const workspace = resolveWorkspace();
    const store = new SwarmStore(workspace);
    try {
      store.init();
      store.addEvent(
        createEvent({
          actor: "harness",
          type: "harness.initialized",
          entityType: "harness",
          entityId: "local",
          payload: { workspace, force: Boolean(options.force) },
        }),
      );
      console.log(`Initialized harness at ${swarmDir(workspace)}`);
    } finally {
      store.close();
    }
  });

program
  .command("status")
  .description("Show current harness status")
  .action(() => {
    printStatus();
  });

const runModeCommand = program.command("run-mode").description("Manage the current harness run mode label");

runModeCommand
  .command("set")
  .description("Set the current run mode shown in observability")
  .argument("<mode>", "fixture, scripted-codex, live-agent-smoke, or unspecified")
  .action((mode: string) => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      const parsed = parseRunMode(mode);
      store.setMeta(RUN_MODE_META_KEY, parsed);
      store.addEvent(
        createEvent({
          actor: "harness",
          type: "run_mode.set",
          entityType: "harness",
          entityId: "local",
          payload: { runMode: parsed },
        }),
      );
      console.log(`Run mode set to ${parsed}`);
    } finally {
      store.close();
    }
  });

runModeCommand
  .command("show")
  .description("Show the current run mode")
  .action(() => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      console.log(currentRunMode(store));
    } finally {
      store.close();
    }
  });

const target = program.command("target").description("Manage target repositories");

target
  .command("init")
  .description("Initialize target repo .swarm defaults")
  .argument("<repo>", "target repository path")
  .action((repo: string) => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      const result = initTarget(repo);
      const now = new Date().toISOString();
      store.addOrUpdateTarget({
        id: result.id,
        path: result.repoPath,
        name: result.config.target.name,
        config: result.config,
        now,
      });
      store.addEvent(
        createEvent({
          actor: "harness",
          type: "target.initialized",
          entityType: "target",
          entityId: result.id,
          payload: {
            path: result.repoPath,
            wroteTargetConfig: result.wroteTargetConfig,
            wroteProtocolConfig: result.wroteProtocolConfig,
          },
        }),
      );
      console.log(`Initialized target ${result.config.target.name}`);
      console.log(`  path: ${result.repoPath}`);
      console.log(`  target.yaml: ${result.wroteTargetConfig ? "created" : "already existed"}`);
      console.log(`  protocol.yaml: ${result.wroteProtocolConfig ? "created" : "already existed"}`);
    } finally {
      store.close();
    }
  });

const lanes = program.command("lanes").description("Manage lanes");

lanes
  .command("close")
  .description("Close a lane that has no active work")
  .argument("<lane-id>", "lane identifier")
  .requiredOption("--reason <reason>", "visible closure reason")
  .option("--actor <actor>", "actor closing the lane", "planning-agent")
  .action((laneId: string, options: { reason: string; actor: string }) => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      const lane = store.listLanes().find((item) => item.id === laneId);
      if (!lane) throw new Error(`Lane not found: ${laneId}`);
      const activeSlices = store
        .listSlices()
        .filter((slice) => slice.laneId === lane.id && !["accepted", "closed"].includes(slice.status));
      if (activeSlices.length > 0) {
        throw new Error(`Lane ${lane.id} still has active slices: ${activeSlices.map((slice) => slice.id).join(", ")}`);
      }
      store.updateLaneState(lane.id, "closed");
      store.addEvent(
        createEvent({
          actor: options.actor,
          type: "lane.closed",
          entityType: "lane",
          entityId: lane.id,
          payload: { reason: options.reason },
        }),
      );
      console.log(`Closed lane ${lane.id}`);
      console.log(`  reason: ${options.reason}`);
    } finally {
      store.close();
    }
  });

const sources = program.command("sources").description("Manage immutable source specs");

sources
  .command("add-file")
  .description("Register a local Markdown/text source file")
  .argument("<path>", "source file path")
  .option("--domain <domain>", "domain label for planning and reporting")
  .option("--tags <tags>", "comma-separated tags for planning filters")
  .option("--priority <number>", "lower numbers are planned first inside a filtered source set", parseInteger)
  .action((filePath: string, options: { domain?: string; tags?: string; priority?: number }) => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      const source = registerFileSource(filePath, {
        domain: options.domain,
        tags: parseCsv(options.tags),
        priority: options.priority,
      });
      store.addOrUpdateSource(source);
      store.addEvent(
        createEvent({
          actor: "harness",
          type: "source.registered",
          entityType: "source",
          entityId: source.id,
          payload: {
            uri: source.uri,
            title: source.title,
            hash: source.hash,
            domain: sourceDomain(source),
            tags: sourceTags(source),
            priority: sourcePriority(source),
            frAcRefs: sourceFrAcRefs(source),
          },
        }),
      );
      console.log(`Registered source ${source.title}`);
      console.log(`  uri: ${source.uri}`);
      console.log(`  hash: ${source.hash}`);
      console.log(`  domain: ${sourceDomain(source)}`);
      console.log(`  tags: ${sourceTags(source).join(", ") || "none"}`);
      console.log(`  priority: ${sourcePriority(source)}`);
      console.log(`  refs indexed: ${sourceFrAcRefs(source).length}`);
    } finally {
      store.close();
    }
  });

sources
  .command("add-dir")
  .description("Register Markdown/text source files from a directory")
  .argument("<path>", "source directory")
  .option("--domain <domain>", "domain label for planning and reporting")
  .option("--tags <tags>", "comma-separated tags for planning filters")
  .option("--priority <number>", "lower numbers are planned first inside a filtered source set", parseInteger)
  .action((dirPath: string, options: { domain?: string; tags?: string; priority?: number }) => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      const files = listSourceFiles(dirPath);
      for (const file of files) {
        const source = registerFileSource(file, {
          domain: options.domain,
          tags: parseCsv(options.tags),
          priority: options.priority,
        });
        store.addOrUpdateSource(source);
        store.addEvent(
          createEvent({
            actor: "harness",
            type: "source.registered",
            entityType: "source",
            entityId: source.id,
            payload: {
              uri: source.uri,
              title: source.title,
              hash: source.hash,
              domain: sourceDomain(source),
              tags: sourceTags(source),
              priority: sourcePriority(source),
              frAcRefs: sourceFrAcRefs(source),
            },
          }),
        );
      }
      console.log(`Registered ${files.length} source file(s) from ${path.resolve(dirPath)}`);
    } finally {
      store.close();
    }
  });

sources
  .command("list")
  .description("List registered immutable source specs with derived planning metadata")
  .option("--domain <domain>", "filter by domain")
  .option("--tag <tag>", "filter by tag")
  .action((options: { domain?: string; tag?: string }) => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      const sources = store
        .listSources()
        .filter((source) => !options.domain || sourceDomain(source).toLowerCase() === options.domain.toLowerCase())
        .filter((source) => !options.tag || sourceTags(source).map((tag) => tag.toLowerCase()).includes(options.tag.toLowerCase()))
        .sort((a, b) => sourcePriority(a) - sourcePriority(b) || a.title.localeCompare(b.title));
      console.log(`Sources: ${sources.length}`);
      for (const source of sources) {
        console.log(`${source.id} ${source.title}`);
        console.log(`  domain: ${sourceDomain(source)} | priority: ${sourcePriority(source)} | tags: ${sourceTags(source).join(", ") || "none"}`);
        console.log(`  refs: ${sourceFrAcRefs(source).length} | hash: ${source.hash.slice(0, 12)} | uri: ${source.uri}`);
      }
    } finally {
      store.close();
    }
  });

sources
  .command("inspect")
  .description("Inspect one source's derived section and FR/AC index")
  .argument("<selector>", "source id, title, basename, or path")
  .action((selector: string) => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      const source = findSource(store, selector);
      if (!source) throw new Error(`Source not found: ${selector}`);
      const sections = sourceSections(source);
      console.log(`Source: ${source.title}`);
      console.log(`ID: ${source.id}`);
      console.log(`URI: ${source.uri}`);
      console.log(`Hash: ${source.hash}`);
      console.log(`Domain: ${sourceDomain(source)} | Priority: ${sourcePriority(source)} | Tags: ${sourceTags(source).join(", ") || "none"}`);
      console.log(`FR/AC refs: ${sourceFrAcRefs(source).join(", ") || "none"}`);
      console.log("");
      console.log(`Sections: ${sections.length}`);
      for (const section of sections) {
        console.log(`  ${section.id}`);
        console.log(`    ${"#".repeat(Math.max(1, section.level))} ${section.title} (lines ${section.startLine}-${section.endLine})`);
        console.log(`    refs: ${section.refs.join(", ") || "none"}`);
        console.log(`    snippet: ${section.snippet || "none"}`);
      }
    } finally {
      store.close();
    }
  });

const search = program.command("search").description("Search indexed harness content");

search
  .command("specs")
  .description("Search registered immutable source specs with lightweight text matching")
  .argument("<query>", "keyword or phrase")
  .option("--domain <domain>", "filter by domain")
  .option("--tag <tag>", "filter by tag")
  .option("--limit <count>", "maximum matching sections", parseInteger, 10)
  .action((query: string, options: { domain?: string; tag?: string; limit: number }) => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      const matches = searchSpecSections(store, query, {
        domain: options.domain,
        tag: options.tag,
        limit: options.limit,
      });
      console.log(`Spec matches: ${matches.length}`);
      for (const match of matches) {
        console.log(`${match.source.title} > ${match.section.title}`);
        console.log(`  source: ${match.source.id} | domain: ${sourceDomain(match.source)} | lines: ${match.section.startLine}-${match.section.endLine}`);
        console.log(`  refs: ${match.section.refs.join(", ") || "none"}`);
        console.log(`  score: ${match.score} | ${match.snippet}`);
      }
    } finally {
      store.close();
    }
  });

const domains = program.command("domains").description("Inspect derived domain planning state");

domains
  .command("list")
  .description("List source domains and FR/AC availability")
  .action(() => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      const summaries = buildDomainSummaries(store);
      console.log(`Domains: ${summaries.length}`);
      for (const domain of summaries) {
        console.log(`${domain.domain}`);
        console.log(
          `  sources: ${domain.sources} | refs: ${domain.refs} | available: ${domain.available} | active: ${domain.active} | blocked: ${domain.blocked} | completed: ${domain.completed}`,
        );
        console.log(
          `  slices: active ${domain.activeSlices}, blocked ${domain.blockedSlices}, accepted ${domain.acceptedSlices} | tags: ${domain.tags.join(", ") || "none"}`,
        );
      }
    } finally {
      store.close();
    }
  });

domains
  .command("inspect")
  .description("Inspect one source domain")
  .argument("<domain>", "domain label")
  .action((domainName: string) => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      const detail = buildDomainDetail(store, domainName);
      if (!detail) throw new Error(`Domain not found: ${domainName}`);
      console.log(`Domain: ${detail.domain}`);
      console.log(
        `Sources: ${detail.sources} | Refs: ${detail.refs} | Available: ${detail.available} | Active: ${detail.active} | Blocked: ${detail.blocked} | Completed: ${detail.completed}`,
      );
      console.log(`Slices: active ${detail.activeSlices}, blocked ${detail.blockedSlices}, accepted ${detail.acceptedSlices}`);
      console.log("");
      console.log("Sources");
      for (const source of detail.sourceDetails) {
        console.log(`  ${source.id} ${source.title}`);
        console.log(`    priority: ${source.priority} | tags: ${source.tags.join(", ") || "none"} | refs: ${source.refs.length}`);
        console.log(`    uri: ${source.uri}`);
      }
      console.log("");
      console.log("FR/AC Status");
      for (const item of detail.refStatuses) {
        console.log(`  ${item.ref}: ${item.status}${item.sliceId ? ` (${item.sliceId})` : ""}`);
      }
    } finally {
      store.close();
    }
  });

const slices = program.command("slices").description("Manage slices");

slices
  .command("pull")
  .description("Create the next available MVP slice from registered sources")
  .option("--target <selector>", "target id, name, basename, or path")
  .option("--source <selector>", "source id, title, basename, or path")
  .option("--domain <domain>", "pull from the next available source in a domain")
  .option("--tag <tag>", "pull from sources carrying this tag")
  .option("--new-lane", "create a new lane instead of reusing an active lane")
  .option("--lane-name <name>", "lane name")
  .option("--lane-purpose <purpose>", "lane purpose")
  .option("--lane-labels <labels>", "comma-separated focus labels")
  .option("--orchestrator <actor>", "lead orchestrator actor", "planning-agent")
  .option("--batch-size <count>", "number of FR/AC refs to claim", parseInteger)
  .action((options: {
    target?: string;
    source?: string;
    domain?: string;
    tag?: string;
    newLane?: boolean;
    laneName?: string;
    lanePurpose?: string;
    laneLabels?: string;
    orchestrator?: string;
    batchSize?: number;
  }) => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      const result = pullNextSlice(store, {
        target: options.target,
        source: options.source,
        domain: options.domain,
        tags: options.tag ? [options.tag] : undefined,
        newLane: options.newLane,
        laneName: options.laneName,
        lanePurpose: options.lanePurpose,
        laneLabels: parseCsv(options.laneLabels),
        orchestrator: options.orchestrator,
        batchSize: options.batchSize,
      });
      console.log(`Created slice ${result.slice.id}`);
      console.log(`  title: ${result.slice.title}`);
      console.log(`  lane: ${result.lane.name} (${result.reusedExistingLane ? "reused" : "created"})`);
      console.log(`  leases: ${result.leases.map((lease) => lease.frAcRef).join(", ")}`);
      console.log(`  dependencies: ${result.dependencies.length}`);
    } finally {
      store.close();
    }
  });

slices
  .command("release")
  .description("Release active leases for a slice and close it")
  .argument("<slice-id>", "slice identifier")
  .requiredOption("--reason <reason>", "visible release reason")
  .option("--actor <actor>", "actor releasing the slice", "planning-agent")
  .action((sliceId: string, options: { reason: string; actor: string }) => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      const slice = store.listSlices().find((item) => item.id === sliceId);
      if (!slice) throw new Error(`Slice not found: ${sliceId}`);
      if (slice.status === "accepted") {
        throw new Error("Accepted slices cannot be released. Completed FR/ACs are not returned to the pool.");
      }
      store.releaseLeasesForSlice(slice.id);
      store.updateSliceStatus(slice.id, "closed");
      store.addEvent(
        createEvent({
          actor: options.actor,
          type: "slice.released",
          entityType: "slice",
          entityId: slice.id,
          payload: { reason: options.reason },
        }),
      );
      console.log(`Released and closed slice ${slice.id}`);
      console.log(`  reason: ${options.reason}`);
    } finally {
      store.close();
    }
  });

program
  .command("run")
  .description("Run a real implementation worker for a slice")
  .argument("<slice-id>", "slice identifier")
  .option("--actor <actor>", "worker actor id shown in observability", "worker")
  .option("--driver <driver>", "worker driver (fixture or a registered driver); defaults to protocol workers.defaultDriver")
  .option("--model <model>", "model override passed to the worker driver")
  .action(async (sliceId: string, options: { actor: string; driver?: string; model?: string }) => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      const result = await executeWorkerRun({
        workspace,
        store,
        sliceId,
        actor: options.actor,
        driver: options.driver ? parseWorkerDriver(options.driver) : undefined,
        model: options.model,
        reason: "direct_run",
      });
      printWorkerRunResult(result);
    } finally {
      store.close();
    }
  });

program
  .command("orchestrate")
  .description("Run a visible overseer/planner agent for a live smoke scenario")
  .option("--actor <actor>", "overseer actor id shown in observability", "live-overseer")
  .option("--driver <driver>", "overseer driver: codex or fixture", "codex")
  .option("--scenario <scenario>", "scenario id from the live smoke manifest", "live-agent-smoke")
  .option("--model <model>", "Codex model override")
  .option("--execute", "execute bounded, allowlisted overseer recommended commands")
  .option("--execute-limit <count>", "maximum recommended commands to execute", parseInteger, 3)
  .action(async (options: { actor: string; driver: string; scenario: string; model?: string; execute?: boolean; executeLimit: number }) => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      const result = await executeOverseerRun({
        workspace,
        store,
        actor: options.actor,
        driver: parseWorkerDriver(options.driver),
        scenario: options.scenario,
        model: options.model,
        execute: Boolean(options.execute),
        executeLimit: options.executeLimit,
      });
      printOverseerRunResult(result);
    } finally {
      store.close();
    }
  });

program
  .command("review")
  .description("Run an independent reviewer for a slice")
  .argument("<slice-id>", "slice identifier")
  .option("--actor <actor>", "reviewer actor id shown in observability", "reviewer")
  .option("--driver <driver>", "reviewer driver (fixture or a registered driver)", "codex")
  .option("--model <model>", "model override passed to the reviewer driver")
  .action(async (sliceId: string, options: { actor: string; driver: string; model?: string }) => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      const result = await executeReviewRun({
        workspace,
        store,
        sliceId,
        actor: options.actor,
        driver: parseWorkerDriver(options.driver),
        model: options.model,
      });
      printReviewRunResult(result);
    } finally {
      store.close();
    }
  });

program
  .command("verify")
  .description("Run configured target verification for a slice")
  .argument("<slice-id>", "slice identifier")
  .option("--actor <actor>", "verifier actor id shown in observability", "verifier")
  .option("--force", "verify even when the slice has not been marked implemented")
  .action((sliceId: string, options: { actor: string; force?: boolean }) => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      const slice = store.listSlices().find((item) => item.id === sliceId);
      if (!slice) throw new Error(`Slice not found: ${sliceId}`);
      const verifiableStates = new Set(["implemented", "verifying", "ready_for_review", "accepted"]);
      if (!options.force && !verifiableStates.has(slice.status)) {
        throw new Error(
          `Slice ${slice.id} is ${slice.status}; verification requires implemented/ready_for_review state. Use --force only for diagnostics.`,
        );
      }
      const target = store.targetById(slice.targetId);
      if (!target) throw new Error(`Target not found for slice: ${slice.targetId}`);
      const configPath = path.join(target.path, ".swarm", "target.yaml");
      if (!fs.existsSync(configPath)) {
        throw new Error(`Target config not found: ${configPath}`);
      }
      const config = YAML.parse(fs.readFileSync(configPath, "utf8")) as {
        commands?: Record<string, string>;
      };
      const command = config.commands?.test;
      if (!command) {
        throw new Error(`No test command configured in ${configPath}`);
      }

      store.updateSliceStatus(slice.id, "verifying");
      store.upsertHeartbeat({
        id: `heartbeat:${options.actor}`,
        actor: options.actor,
        state: "verifying",
        detail: "Running target verification command",
        entityType: "slice",
        entityId: slice.id,
      });
      store.addEvent(
        createEvent({
          actor: options.actor,
          type: "verification.started",
          entityType: "slice",
          entityId: slice.id,
          payload: { command, cwd: target.path },
        }),
      );

      const result = spawnSync(command, {
        cwd: target.path,
        shell: true,
        encoding: "utf8",
      });
      const commandPassed = result.status === 0;
      const workerGate = readAndValidateWorkerResult(store, slice, options.actor);
      const reviewGate = readLatestReviewGate(store, slice, options.actor);
      const activeAcceptanceBlockers = store
        .listEscalations("active")
        .filter((item) => item.entityId === slice.id && ["blocker", "human_required", "critical"].includes(item.level));
      const verificationEvidenceId = makeId("evidence");
      const frAcResults = buildFrAcResults({
        slice,
        verifier: options.actor,
        commandPassed,
        workerGate,
        verificationEvidenceId,
      });
      const perRefPassed = frAcResults.every((result) => result.status === "passed" || result.status === "overridden");
      const passed = commandPassed && workerGate.passed && reviewGate.passed && activeAcceptanceBlockers.length === 0 && perRefPassed;
      const failedStatus: SliceRecord["status"] = reviewGate.status === "repair_required" ? "repairing" : "blocked";
      store.updateSliceStatus(slice.id, passed ? "accepted" : failedStatus);
      if (passed) {
        store.completeLeasesForSlice(slice.id);
      }
      store.updateDependenciesFor("slice", slice.id, passed ? "satisfied" : "blocked");
      store.insertEvidence({
        id: verificationEvidenceId,
        sliceId: slice.id,
        kind: "command",
        summary: `Verification command ${passed ? "passed" : "failed"}: ${command}`,
        payload: {
          command,
          cwd: target.path,
          exitCode: result.status,
          passed,
          commandPassed,
          workerGate,
          reviewGate,
          activeAcceptanceBlockers,
          frAcResults,
          missingRefs: frAcResults.filter((item) => item.status === "missing_evidence").map((item) => item.ref),
          failedRefs: frAcResults.filter((item) => item.status === "failed").map((item) => item.ref),
          stdout: trimOutput(result.stdout),
          stderr: trimOutput(result.stderr),
        },
        createdAt: new Date().toISOString(),
      });
      store.upsertHeartbeat({
        id: `heartbeat:${options.actor}`,
        actor: options.actor,
        state: passed ? "idle" : "blocked",
        detail: passed ? "Verification passed" : "Verification failed",
        entityType: "slice",
        entityId: slice.id,
      });
      store.addEvent(
        createEvent({
          actor: options.actor,
          type: "verification.completed",
          entityType: "slice",
          entityId: slice.id,
          payload: {
            command,
            cwd: target.path,
            exitCode: result.status,
            passed,
            commandPassed,
            workerGate,
            reviewGate,
            activeAcceptanceBlockers,
            frAcResults,
            missingRefs: frAcResults.filter((item) => item.status === "missing_evidence").map((item) => item.ref),
            failedRefs: frAcResults.filter((item) => item.status === "failed").map((item) => item.ref),
            stdout: trimOutput(result.stdout),
            stderr: trimOutput(result.stderr),
          },
        }),
      );
      refreshCheckpoint({
        store,
        role: "verifier",
        entityType: "slice",
        entityId: slice.id,
        actor: options.actor,
        reason: "Verification completed.",
      });
      if (passed) {
        detectAndRecordLowSignalWork(store, slice);
      }
      console.log(`Verification ${passed ? "passed" : "failed"} for ${slice.id}`);
      console.log(`  command: ${command}`);
      console.log(`  exit code: ${result.status}`);
      if (!workerGate.passed) console.log(`  worker gate: ${workerGate.reason}`);
      if (!reviewGate.passed) console.log(`  review gate: ${reviewGate.reason}`);
      if (activeAcceptanceBlockers.length > 0) {
        console.log(`  active blockers: ${activeAcceptanceBlockers.map((item) => item.id).join(", ")}`);
      }
      const missingRefs = frAcResults.filter((item) => item.status === "missing_evidence").map((item) => item.ref);
      const failedRefs = frAcResults.filter((item) => item.status === "failed").map((item) => item.ref);
      if (missingRefs.length > 0) console.log(`  missing FR/AC evidence: ${missingRefs.join(", ")}`);
      if (failedRefs.length > 0) console.log(`  failed FR/AC evidence: ${failedRefs.join(", ")}`);
      if (result.stdout.trim()) console.log(result.stdout.trim());
      if (result.stderr.trim()) console.error(result.stderr.trim());
    } finally {
      store.close();
    }
  });

program
  .command("observe")
  .description("Print a JSON observability snapshot")
  .option("--events <count>", "recent event count", parseInteger, 20)
  .option("--out <path>", "write snapshot to a file instead of stdout")
  .action((options: { events: number; out?: string }) => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      const snapshot = JSON.stringify(buildObservabilitySnapshot(store, workspace, options.events), null, 2);
      if (options.out) {
        const outPath = path.resolve(options.out);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, `${snapshot}\n`, "utf8");
        console.log(`Wrote observability snapshot to ${outPath}`);
        return;
      }
      console.log(snapshot);
    } finally {
      store.close();
    }
  });

program
  .command("timeline")
  .description("Print a scoped timeline for a slice, lane, or other entity")
  .argument("<entity-id>", "slice/lane/FR/AC-like ref identifier")
  .option("--json", "print timeline as JSON")
  .action((entityId: string, options: { json?: boolean }) => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      const timeline = buildTimeline(store, entityId);
      if (options.json) {
        console.log(JSON.stringify(timeline, null, 2));
        return;
      }
      console.log(`Timeline: ${timeline.entityId}`);
      console.log(`Entity type: ${timeline.entityType ?? "unknown"}`);
      console.log("");
      for (const item of timeline.items) {
        const suffix = item.detail ? ` - ${item.detail}` : "";
        console.log(`${item.timestamp} ${item.kind} ${item.actor ?? ""} ${item.label}${suffix}`.trim());
      }
    } finally {
      store.close();
    }
  });

program
  .command("graph")
  .description("Print the harness dependency and evidence graph")
  .option("--format <format>", "json or dot", "json")
  .action((options: { format: string }) => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      const graph = buildGraph(store);
      const format = parseGraphFormat(options.format);
      if (format === "dot") {
        console.log(renderDot(graph));
        return;
      }
      console.log(JSON.stringify(graph, null, 2));
    } finally {
      store.close();
    }
  });

program
  .command("report")
  .description("Print a simple slice report")
  .argument("<slice-id>", "slice identifier")
  .action((sliceId: string) => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      console.log(buildSliceReport(store, sliceId));
    } finally {
      store.close();
    }
  });

const checkpoint = program.command("checkpoint").description("Manage latest role/entity checkpoints");

checkpoint
  .command("create")
  .description("Create or refresh a latest checkpoint for a role/entity")
  .requiredOption("--entity <selector>", "entity selector like slice:SLICE-id, lane:LANE-id, or agent_run:RUN-id")
  .requiredOption("--role <role>", "planner, worker, verifier, reviewer, recovery, or overseer")
  .option("--actor <actor>", "checkpoint creator", "checkpoint-agent")
  .action((options: { entity: string; role: string; actor: string }) => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      const entity = parseEntitySelector(options.entity);
      ensureEntityExists(store, entity.entityType, entity.entityId);
      const record = refreshCheckpoint({
        store,
        role: parseCheckpointRole(options.role),
        entityType: entity.entityType,
        entityId: entity.entityId,
        actor: options.actor,
        reason: "Manual checkpoint command.",
      });
      console.log(`Refreshed checkpoint ${record.id}`);
      console.log(`  role: ${record.role}`);
      console.log(`  entity: ${record.entityType}:${record.entityId}`);
      console.log(`  summary: ${record.summary}`);
    } finally {
      store.close();
    }
  });

checkpoint
  .command("list")
  .description("List latest checkpoints")
  .action(() => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      const checkpoints = store.listCheckpoints();
      console.log(`Checkpoints: ${checkpoints.length}`);
      for (const item of checkpoints) {
        console.log(`${item.id} ${item.role} ${item.entityType}:${item.entityId} ${item.updatedAt}`);
        console.log(`  ${item.summary}`);
      }
    } finally {
      store.close();
    }
  });

checkpoint
  .command("show")
  .description("Show a checkpoint")
  .argument("<checkpoint-id>", "checkpoint identifier")
  .action((checkpointId: string) => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      const record = store.checkpointById(checkpointId);
      if (!record) throw new Error(`Checkpoint not found: ${checkpointId}`);
      console.log(renderCheckpoint(record));
    } finally {
      store.close();
    }
  });

program
  .command("resume-context")
  .description("Generate a role-specific resume packet from durable harness state")
  .option("--entity <selector>", "entity selector like slice:SLICE-id, lane:LANE-id, or agent_run:RUN-id")
  .option("--role <role>", "planner, worker, verifier, reviewer, recovery, or overseer")
  .option("--run <run-id>", "agent run id; defaults role to recovery")
  .action((options: { entity?: string; role?: string; run?: string }) => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      const entity = options.run
        ? { entityType: "agent_run" as const, entityId: options.run }
        : options.entity
          ? parseEntitySelector(options.entity)
          : undefined;
      if (!entity) throw new Error("Provide --entity <type:id> or --run <run-id>.");
      ensureEntityExists(store, entity.entityType, entity.entityId);
      const role = parseCheckpointRole(options.role ?? (options.run ? "recovery" : "worker"));
      console.log(buildResumePacket({ store, role, entityType: entity.entityType, entityId: entity.entityId }));
    } finally {
      store.close();
    }
  });

program
  .command("serve")
  .description("Serve a local read-only web observability viewer")
  .option("--workspace <path>", "harness workspace to observe", process.cwd())
  .option("--host <host>", "bind host", "127.0.0.1")
  .option("--port <port>", "bind port; use 0 to choose a free port", parsePort, 4317)
  .option("--events <count>", "default snapshot event count", parseInteger, 80)
  .option("--history-root <path>", "live-agent run history root; defaults beside .swarm-demo workspaces")
  .action((options: { workspace: string; host: string; port: number; events: number; historyRoot?: string }) => {
    const workspace = path.resolve(options.workspace);
    ensureInitialized(workspace);
    const historyRoot = options.historyRoot ? path.resolve(options.historyRoot) : defaultLiveRunHistoryRoot(workspace);
    const server = createWebViewerServer({ workspace, defaultEventCount: options.events, historyRoot });
    server.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        console.error(`Port ${options.port} is already in use on ${options.host}.`);
        console.error("Try a different port, for example:");
        console.error(`  swarm serve --workspace ${workspace} --host ${options.host} --port 4318`);
        console.error("Or let the OS choose a free port:");
        console.error(`  swarm serve --workspace ${workspace} --host ${options.host} --port 0`);
        process.exitCode = 1;
        return;
      }
      console.error(`Failed to start web viewer: ${error.message}`);
      process.exitCode = 1;
    });
    server.listen(options.port, options.host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      console.log("Agent Swarm web observability viewer");
      console.log(`  workspace: ${workspace}`);
      console.log(`  history: ${historyRoot}`);
      console.log(`  url: http://${options.host}:${port}/`);
      console.log("  mode: read-only");
    });
  });

const escalations = program.command("escalations").description("Manage scoped escalations");

escalations
  .command("create")
  .description("Create a scoped escalation")
  .requiredOption("--level <level>", "info, warning, blocker, human_required, or critical")
  .requiredOption("--entity-type <type>", "slice, lane, dependency, lease, or other harness entity")
  .requiredOption("--entity-id <id>", "entity identifier")
  .requiredOption("--message <message>", "visible escalation message")
  .option("--actor <actor>", "creator actor", "harness")
  .action((options: { level: string; entityType: string; entityId: string; message: string; actor: string }) => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      const now = new Date().toISOString();
      const escalation = {
        id: makeId("escalation"),
        level: parseEscalationLevel(options.level),
        status: "active" as const,
        entityType: parseEntityType(options.entityType),
        entityId: options.entityId,
        message: options.message,
        createdBy: options.actor,
        createdAt: now,
        updatedAt: now,
      };
      store.insertEscalation(escalation);
      store.addEvent(
        createEvent({
          actor: options.actor,
          type: "escalation.created",
          entityType: escalation.entityType,
          entityId: escalation.entityId,
          payload: { escalationId: escalation.id, level: escalation.level, message: escalation.message },
        }),
      );
      refreshCheckpoint({
        store,
        role: "overseer",
        entityType: escalation.entityType,
        entityId: escalation.entityId,
        actor: options.actor,
        reason: "Escalation created.",
      });
      console.log(`Created escalation ${escalation.id}`);
    } finally {
      store.close();
    }
  });

escalations
  .command("clear")
  .description("Clear an active escalation with a reason")
  .argument("<escalation-id>", "escalation identifier")
  .requiredOption("--reason <reason>", "clearance reason or evidence reference")
  .option("--actor <actor>", "clearing actor", "harness")
  .action((id: string, options: { reason: string; actor: string }) => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      store.clearEscalation(id, { reason: options.reason, clearedBy: options.actor });
      store.addEvent(
        createEvent({
          actor: options.actor,
          type: "escalation.cleared",
          entityType: "escalation",
          entityId: id,
          payload: { reason: options.reason },
        }),
      );
      console.log(`Cleared escalation ${id}`);
    } finally {
      store.close();
    }
  });

const recovery = program.command("recovery").description("Inspect and recover stalled agent runs");

recovery
  .command("scan")
  .description("Find stale running agent runs")
  .option("--stale-after <seconds>", "heartbeat age threshold in seconds; defaults to target protocol", parseInteger)
  .option("--mark-stale", "mark stale runs blocked/stale and raise scoped blocker escalations")
  .option("--release", "release stale affected slices back to the pool")
  .option("--actor <actor>", "recovery actor", "recovery-agent")
  .action((options: { staleAfter?: number; markStale?: boolean; release?: boolean; actor: string }) => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      const staleAfter = options.staleAfter ?? defaultStaleAfterForStore(store);
      const staleRuns = findStaleAgentRuns(store, staleAfter);
      console.log(`Stale agent runs: ${staleRuns.length}`);
      console.log(`  stale after: ${staleAfter}s`);
      for (const item of staleRuns) {
        const entityType = item.run.entityType ?? "slice";
        const entityId = item.run.entityId ?? item.run.sliceId;
        console.log(`  - ${item.run.id} ${item.run.actor} ${entityType}:${entityId} age:${formatDuration(item.ageMs)}`);
        if (item.heartbeat?.detail) console.log(`    heartbeat: ${item.heartbeat.state} - ${item.heartbeat.detail}`);
        if (!options.markStale && !options.release) continue;

        store.updateAgentRun(item.run.id, { status: options.release ? "released" : "stale" });
        store.upsertHeartbeat({
          id: `heartbeat:${item.run.actor}`,
          actor: item.run.actor,
          state: "blocked",
          detail: options.release ? "Stale run released by recovery scan" : "Stale run marked for recovery",
          entityType,
          entityId,
        });
        const slice = entityType === "slice" ? store.listSlices().find((candidate) => candidate.id === entityId) : undefined;
        if (slice && !["accepted", "closed"].includes(slice.status)) {
          store.updateSliceStatus(slice.id, options.release ? "closed" : "blocked");
          if (options.release) store.releaseLeasesForSlice(slice.id);
        }
        const existingEscalation = store
          .listEscalations("active")
          .some((escalation) => escalation.entityType === entityType && escalation.entityId === entityId && escalation.message.includes(item.run.id));
        if (!existingEscalation) {
          const now = new Date().toISOString();
          store.insertEscalation({
            id: makeId("escalation"),
            level: "blocker",
            status: "active",
            entityType,
            entityId,
            message: `Agent run ${item.run.id} is stale after ${formatDuration(item.ageMs)}.`,
            createdBy: options.actor,
            createdAt: now,
            updatedAt: now,
          });
        }
        store.addEvent(
          createEvent({
            actor: options.actor,
            type: options.release ? "recovery.released_stale_run" : "recovery.marked_stale_run",
            entityType: "agent_run",
            entityId: item.run.id,
            payload: {
              sliceId: item.run.sliceId,
              entityType,
              entityId,
              ageMs: item.ageMs,
              staleAfterSeconds: staleAfter,
            },
          }),
        );
        refreshCheckpoint({
          store,
          role: "recovery",
          entityType: "agent_run",
          entityId: item.run.id,
          actor: options.actor,
          reason: options.release ? "Stale run released by recovery scan." : "Stale run marked for recovery.",
        });
      }
    } finally {
      store.close();
    }
  });

recovery
  .command("revive")
  .description("Resume a stale agent run by captured session id")
  .argument("<run-id>", "agent run identifier")
  .option("--actor <actor>", "recovery actor", "recovery-agent")
  .option("--model <model>", "model override passed to the worker driver")
  .action(async (runId: string, options: { actor: string; model?: string }) => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      const previousRun = store.listAgentRuns().find((run) => run.id === runId);
      if (!previousRun) throw new Error(`Agent run not found: ${runId}`);
      const adapter = getWorkerDriver(previousRun.driver);
      if (!adapter?.capabilities.resume) {
        throw new Error(`Agent run ${runId} uses driver ${previousRun.driver}, which does not support resume.`);
      }
      if (!previousRun.sessionId) throw new Error(`Agent run ${runId} does not have a captured worker session id.`);
      const slice = store.listSlices().find((item) => item.id === previousRun.sliceId);
      if (!slice) throw new Error(`Slice not found for run ${runId}: ${previousRun.sliceId}`);
      const target = store.targetById(slice.targetId);
      if (!target) throw new Error(`Target not found for slice: ${slice.targetId}`);

      const revivedRunId = makeId("agentRun");
      const now = new Date().toISOString();
      const attempt = store.listAgentRuns().filter((run) => run.sliceId === slice.id && run.actor === previousRun.actor).length + 1;
      const artifactPath = path.join(artifactsDir(workspace), slice.id);
      fs.mkdirSync(artifactPath, { recursive: true });
      const jsonlPath = path.join(artifactPath, `worker-revive-${revivedRunId}.jsonl`);
      const lastMessagePath = path.join(artifactPath, `worker-result-${revivedRunId}.json`);
      const schemaPath = path.join(workspace, "schemas", "worker-result.schema.json");
      writeWorkerResultSchema(schemaPath);
      const prompt = `Continue the implementation for slice ${slice.id}. Preserve the immutable FR/AC scope and finish with the required worker result JSON if possible.`;

      store.insertAgentRun({
        id: revivedRunId,
        sliceId: slice.id,
        role: previousRun.role ?? "worker",
        entityType: "slice",
        entityId: slice.id,
        actor: previousRun.actor,
        driver: previousRun.driver,
        status: "running",
        sessionId: previousRun.sessionId,
        attempt,
        startedAt: now,
        updatedAt: now,
      });
      store.updateSliceStatus(slice.id, "implementing");
      store.upsertHeartbeat({
        id: `heartbeat:${previousRun.actor}`,
        actor: previousRun.actor,
        state: "thinking",
        detail: `Reviving worker session ${previousRun.sessionId}`,
        entityType: "slice",
        entityId: slice.id,
      });
      store.addEvent(
        createEvent({
          actor: options.actor,
          type: "recovery.revive_started",
          entityType: "agent_run",
          entityId: revivedRunId,
          payload: {
            previousRunId: previousRun.id,
            sliceId: slice.id,
            sessionId: previousRun.sessionId,
            attempt,
          },
        }),
      );
      refreshCheckpoint({
        store,
        role: "recovery",
        entityType: "agent_run",
        entityId: revivedRunId,
        actor: options.actor,
        reason: "Revive started.",
      });

      const protocol = loadProtocol(target.path);
      const spec: WorkerRunSpec = {
        prompt,
        targetPath: target.path,
        schemaPath,
        resultPath: lastMessagePath,
        model: options.model,
        resumeSessionId: previousRun.sessionId,
        driverConfig: protocol.protocol.workers.drivers[previousRun.driver] ?? {},
      };
      const invocation = adapter.buildInvocation(spec);
      const result = await spawnWorkerStreaming({
        command: invocation.command,
        args: invocation.args,
        cwd: target.path,
        jsonlPath,
        actor: previousRun.actor,
        sliceId: slice.id,
        store,
        driver: previousRun.driver,
        classify: adapter.classifyHeartbeat?.bind(adapter),
      });
      const finalization = adapter.finalize({ exitCode: result.status, stdout: result.stdout ?? "", spec });
      const stderrPath = result.stderr ? path.join(artifactPath, `worker-revive-${revivedRunId}-stderr.log`) : undefined;
      if (stderrPath && result.stderr) fs.writeFileSync(stderrPath, result.stderr, "utf8");
      const workerEvents = result.workerEvents;
      store.updateAgentRun(revivedRunId, {
        status: finalization.ok ? "completed" : "failed",
        sessionId: workerEvents.sessionId ?? previousRun.sessionId,
        eventsPath: jsonlPath,
        resultPath: fs.existsSync(lastMessagePath) ? lastMessagePath : undefined,
        stderrPath,
      });
      if (fs.existsSync(lastMessagePath)) {
        store.insertEvidence({
          id: makeId("evidence"),
          sliceId: slice.id,
          kind: "worker_result",
          summary: "Structured worker revive result",
          ref: lastMessagePath,
          payload: { path: lastMessagePath, revivedFrom: previousRun.id },
          createdAt: new Date().toISOString(),
        });
      }
      store.updateSliceStatus(slice.id, finalization.ok ? "implemented" : "blocked");
      store.upsertHeartbeat({
        id: `heartbeat:${previousRun.actor}`,
        actor: previousRun.actor,
        state: finalization.ok ? "idle" : "blocked",
        detail: finalization.ok ? `${previousRun.driver} revive completed` : `${previousRun.driver} revive failed`,
        entityType: "slice",
        entityId: slice.id,
      });
      store.addEvent(
        createEvent({
          actor: options.actor,
          type: "recovery.revive_completed",
          entityType: "agent_run",
          entityId: revivedRunId,
          payload: {
            previousRunId: previousRun.id,
            sliceId: slice.id,
            driver: previousRun.driver,
            ok: finalization.ok,
            failureReason: finalization.failureReason,
            costUsd: finalization.costUsd,
            exitCode: result.status,
            workerEvents,
            structuredResultWritten: finalization.structuredResultWritten,
            eventsPath: jsonlPath,
            resultPath: fs.existsSync(lastMessagePath) ? lastMessagePath : undefined,
          },
        }),
      );
      refreshCheckpoint({
        store,
        role: "recovery",
        entityType: "agent_run",
        entityId: revivedRunId,
        actor: options.actor,
        reason: "Revive completed.",
      });
      console.log(`${finalization.ok ? "Revived" : "Revive failed"} for ${runId}`);
      console.log(`  new run: ${revivedRunId}`);
      console.log(`  session: ${previousRun.sessionId}`);
      console.log(`  events: ${jsonlPath}`);
      console.log(`  ingested events: ${workerEvents.eventCount}`);
      if (result.stderr?.trim()) console.error(result.stderr.trim());
    } finally {
      store.close();
    }
  });

recovery
  .command("restart")
  .description("Start a fresh worker run for the same slice, using prior run history")
  .argument("<run-id>", "agent run identifier")
  .option("--actor <actor>", "replacement worker actor; defaults to the previous actor")
  .option("--driver <driver>", "worker driver (fixture or a registered driver); defaults to previous run driver")
  .option("--model <model>", "model override passed to the worker driver")
  .action(async (runId: string, options: { actor?: string; driver?: string; model?: string }) => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      const previousRun = store.listAgentRuns().find((run) => run.id === runId);
      if (!previousRun) throw new Error(`Agent run not found: ${runId}`);
      const driver = options.driver ? parseWorkerDriver(options.driver) : previousRun.driver;
      store.addEvent(
        createEvent({
          actor: "recovery-agent",
          type: "recovery.restart_started",
          entityType: "agent_run",
          entityId: previousRun.id,
          payload: {
            sliceId: previousRun.sliceId,
            previousRunId: previousRun.id,
            previousStatus: previousRun.status,
            driver,
          },
        }),
      );
      refreshCheckpoint({
        store,
        role: "recovery",
        entityType: "agent_run",
        entityId: previousRun.id,
        actor: "recovery-agent",
        reason: "Restart started.",
      });
      const result = await executeWorkerRun({
        workspace,
        store,
        sliceId: previousRun.sliceId,
        actor: options.actor ?? previousRun.actor,
        driver,
        model: options.model,
        reason: "restart",
        previousRunId: previousRun.id,
      });
      store.addEvent(
        createEvent({
          actor: "recovery-agent",
          type: "recovery.restart_completed",
          entityType: "agent_run",
          entityId: result.runId,
          payload: {
            sliceId: result.sliceId,
            previousRunId: previousRun.id,
            exitCode: result.exitCode,
          },
        }),
      );
      refreshCheckpoint({
        store,
        role: "recovery",
        entityType: "agent_run",
        entityId: result.runId,
        actor: "recovery-agent",
        reason: "Restart completed.",
      });
      printWorkerRunResult(result);
    } finally {
      store.close();
    }
  });

program
  .command("watch")
  .description("Show a lightweight live terminal dashboard")
  .option("--interval <seconds>", "refresh interval in seconds", parseInteger, 2)
  .option("--events <count>", "recent event count", parseInteger, 12)
  .option("--stale-after <seconds>", "mark heartbeat/run ages stale after this many seconds; defaults to target protocol", parseInteger)
  .option("--view <view>", "all, lanes, agents, blockers, or events", "all")
  .option("--once", "render one frame and exit")
  .option("--no-clear", "do not clear the terminal between frames")
  .action(async (options: { interval: number; events: number; staleAfter?: number; view: string; once?: boolean; clear?: boolean }) => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const view = parseWatchView(options.view);
    const initialStore = new SwarmStore(workspace);
    const staleAfter = options.staleAfter ?? defaultStaleAfterForStore(initialStore);
    initialStore.close();
    const render = () => {
      const store = new SwarmStore(workspace);
      try {
        const snapshot = buildObservabilitySnapshot(store, workspace, options.events);
        if (options.clear !== false && !options.once) process.stdout.write("\x1Bc");
        process.stdout.write(`${renderWatchFrame(snapshot, { staleAfterSeconds: staleAfter, view })}\n`);
      } finally {
        store.close();
      }
    };
    render();
    if (options.once) return;
    const intervalMs = Math.max(options.interval, 1) * 1000;
    while (true) {
      await sleep(intervalMs);
      render();
    }
  });

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});

function ensureInitialized(workspace: string): void {
  if (!fs.existsSync(path.join(swarmDir(workspace), "state.db"))) {
    throw new Error("Harness is not initialized. Run `swarm init` first.");
  }
  const store = new SwarmStore(workspace);
  try {
    store.init();
  } finally {
    store.close();
  }
}

async function executeOverseerRun(input: {
  workspace: string;
  store: SwarmStore;
  actor: string;
  driver: string;
  scenario: string;
  model?: string;
  execute?: boolean;
  executeLimit?: number;
}): Promise<OverseerRunResult> {
  const entityId = scenarioEntityId(input.scenario);
  const artifactPath = path.join(artifactsDir(input.workspace), sanitizeArtifactSegment(entityId));
  fs.mkdirSync(artifactPath, { recursive: true });
  const runId = makeId("agentRun");
  const resultPath = path.join(artifactPath, `overseer-decision-${runId}.json`);
  const jsonlPath = path.join(artifactPath, `overseer-events-${runId}.jsonl`);
  const stderrPath = path.join(artifactPath, `overseer-stderr-${runId}.log`);
  const promptPath = path.join(artifactPath, `overseer-prompt-${runId}.md`);
  const schemaPath = path.join(input.workspace, "schemas", "overseer-decision.schema.json");
  writeOverseerDecisionSchema(schemaPath);

  const manifest = loadScenarioManifest(input.workspace, input.scenario);
  const snapshot = buildObservabilitySnapshot(input.store, input.workspace, 120);
  const prompt = buildOverseerPrompt({
    workspace: input.workspace,
    scenario: input.scenario,
    manifest,
    snapshot,
    execute: Boolean(input.execute),
  });
  fs.writeFileSync(promptPath, prompt, "utf8");
  const now = new Date().toISOString();
  const attempt =
    input.store
      .listAgentRuns()
      .filter((run) => run.role === "overseer" && run.entityId === entityId && run.actor === input.actor).length + 1;

  input.store.insertAgentRun({
    id: runId,
    sliceId: entityId,
    role: "overseer",
    entityType: "harness",
    entityId,
    actor: input.actor,
    driver: input.driver,
    status: "running",
    attempt,
    startedAt: now,
    updatedAt: now,
  });
  input.store.upsertHeartbeat({
    id: `heartbeat:${input.actor}`,
    actor: input.actor,
    state: "thinking",
    detail: `Overseer assessing scenario ${input.scenario}`,
    entityType: "harness",
    entityId,
  });
  input.store.addEvent(
    createEvent({
      actor: input.actor,
      type: "overseer.started",
      entityType: "harness",
      entityId,
      payload: {
        runId,
        scenario: input.scenario,
        driver: input.driver,
        model: input.model,
        execute: Boolean(input.execute),
        executeLimit: input.executeLimit,
        attempt,
        manifestPath: manifest.path,
        promptPath,
      },
    }),
  );

  let result: {
    status: number | null;
    stdout?: string;
    stderr?: string;
    workerEvents?: ReturnType<typeof ingestWorkerJsonl>;
  };
  if (input.driver === "fixture") {
    const decision = runFixtureOverseerDecision({ scenario: input.scenario, snapshot });
    fs.writeFileSync(resultPath, `${JSON.stringify(decision)}\n`, "utf8");
    result = {
      status: 0,
      stdout: `${JSON.stringify({ type: "fixture.overseer.completed", scenario: input.scenario, actor: input.actor })}\n`,
    };
  } else {
    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "-C",
      input.workspace,
      "--output-schema",
      schemaPath,
      "--output-last-message",
      resultPath,
    ];
    if (input.model) args.push("--model", input.model);
    args.push(buildOverseerLaunchPrompt(promptPath, input.scenario));
    const codex = resolveDriverCommand("codex", "codex");
    result = await spawnWorkerStreaming({
      command: codex.command,
      args: [...codex.prefixArgs, ...args],
      cwd: input.workspace,
      jsonlPath,
      actor: input.actor,
      sliceId: entityId,
      entityType: "harness",
      entityId,
      store: input.store,
      driver: input.driver,
      eventPrefix: "overseer",
    });
  }

  if (input.driver === "fixture") fs.writeFileSync(jsonlPath, result.stdout ?? "", "utf8");
  if (result.stderr) fs.writeFileSync(stderrPath, result.stderr, "utf8");
  const overseerEvents =
    result.workerEvents ??
    ingestWorkerJsonl({
      store: input.store,
      actor: input.actor,
      sliceId: entityId,
      entityType: "harness",
      entityId,
      jsonl: result.stdout ?? "",
      eventPrefix: "overseer",
    });
  const parsedDecision = readOverseerDecisionFile(resultPath);
  const runCompleted = result.status === 0 && parsedDecision.ok;
  input.store.updateAgentRun(runId, {
    status: runCompleted ? "completed" : "failed",
    sessionId: overseerEvents.sessionId,
    eventsPath: jsonlPath,
    resultPath: fs.existsSync(resultPath) ? resultPath : undefined,
    stderrPath: result.stderr ? stderrPath : undefined,
  });

  let commandResults: OverseerCommandExecution[] = [];
  if (parsedDecision.ok) {
    commandResults = applyOverseerDecision({
      store: input.store,
      workspace: input.workspace,
      actor: input.actor,
      scenario: input.scenario,
      entityId,
      runId,
      decision: parsedDecision.decision,
      resultPath,
      eventsPath: jsonlPath,
      overseerEvents,
      artifactPath,
      execute: Boolean(input.execute),
      executeLimit: input.executeLimit ?? 3,
    });
    refreshCheckpoint({
      store: input.store,
      role: "overseer",
      entityType: "harness",
      entityId,
      actor: input.actor,
      reason: commandResults.length > 0 ? "Overseer decision and bounded command execution recorded." : "Overseer decision recorded.",
    });
  } else {
    input.store.upsertHeartbeat({
      id: `heartbeat:${input.actor}`,
      actor: input.actor,
      state: "blocked",
      detail: parsedDecision.reason,
      entityType: "harness",
      entityId,
    });
    input.store.addEvent(
      createEvent({
        actor: input.actor,
        type: "overseer.failed",
        entityType: "harness",
        entityId,
        payload: {
          runId,
          scenario: input.scenario,
          exitCode: result.status,
          reason: parsedDecision.reason,
          eventsPath: jsonlPath,
          resultPath,
          stderrPath: result.stderr ? stderrPath : undefined,
          overseerEvents,
        },
      }),
    );
  }

  if (!parsedDecision.ok) {
    refreshCheckpoint({
      store: input.store,
      role: "overseer",
      entityType: "harness",
      entityId,
      actor: input.actor,
      reason: "Overseer run failed.",
    });
  }
  refreshCheckpoint({
    store: input.store,
    role: "recovery",
    entityType: "agent_run",
    entityId: runId,
    actor: input.actor,
    reason: "Overseer run available for recovery context.",
  });

  return {
    scenario: input.scenario,
    runId,
    exitCode: result.status,
    eventsPath: jsonlPath,
    resultPath,
    overseerEvents,
    commandResults: commandResults.length > 0 ? commandResults : undefined,
    decision: parsedDecision.ok ? parsedDecision.decision : undefined,
    stderr: result.stderr,
  };
}

async function executeWorkerRun(input: {
  workspace: string;
  store: SwarmStore;
  sliceId: string;
  actor: string;
  driver?: string;
  model?: string;
  reason: "direct_run" | "restart";
  previousRunId?: string;
}): Promise<WorkerRunResult> {
  const slice = input.store.listSlices().find((item) => item.id === input.sliceId);
  if (!slice) throw new Error(`Slice not found: ${input.sliceId}`);
  validateSliceDispatchContract(slice);
  const target = input.store.targetById(slice.targetId);
  if (!target) throw new Error(`Target not found for slice: ${slice.targetId}`);
  const protocol = loadProtocol(target.path);
  const driverId = input.driver ?? protocol.protocol.workers.defaultDriver;
  if (driverId !== "fixture" && !getWorkerDriver(driverId)) {
    throw new Error(`Invalid worker driver: ${driverId}. Expected one of: ${["fixture", ...workerDriverIds()].sort().join(", ")}.`);
  }
  const lane = input.store.listLanes().find((item) => item.id === slice.laneId);
  const artifactPath = path.join(artifactsDir(input.workspace), slice.id);
  fs.mkdirSync(artifactPath, { recursive: true });
  const runId = makeId("agentRun");
  const lastMessagePath = path.join(artifactPath, input.reason === "restart" ? `worker-result-${runId}.json` : "worker-result.json");
  const jsonlPath = path.join(artifactPath, input.reason === "restart" ? `worker-events-${runId}.jsonl` : "worker-events.jsonl");
  const stderrPath = path.join(artifactPath, input.reason === "restart" ? `worker-stderr-${runId}.log` : "worker-stderr.log");
  const schemaPath = path.join(input.workspace, "schemas", "worker-result.schema.json");
  writeWorkerResultSchema(schemaPath);
  const prompt = buildWorkerPrompt({ slice, targetPath: target.path, laneName: lane?.name });
  const now = new Date().toISOString();
  const attempt = input.store.listAgentRuns().filter((run) => run.sliceId === slice.id && run.actor === input.actor).length + 1;

  input.store.updateSliceStatus(slice.id, "implementing");
  input.store.insertAgentRun({
    id: runId,
    sliceId: slice.id,
    role: "worker",
    entityType: "slice",
    entityId: slice.id,
    actor: input.actor,
    driver: driverId,
    status: "running",
    attempt,
    startedAt: now,
    updatedAt: now,
  });
  input.store.upsertHeartbeat({
    id: `heartbeat:${input.actor}`,
    actor: input.actor,
    state: "thinking",
    detail: input.reason === "restart" ? "Fresh worker restarted for slice" : `${driverId} worker process started`,
    entityType: "slice",
    entityId: slice.id,
  });
  input.store.addEvent(
    createEvent({
      actor: input.actor,
      type: input.reason === "restart" ? "worker.restarted" : "worker.started",
      entityType: "slice",
      entityId: slice.id,
      payload: {
        targetPath: target.path,
        laneId: slice.laneId,
        workerActor: input.actor,
        driver: driverId,
        model: input.model,
        runId,
        attempt,
        previousRunId: input.previousRunId,
      },
    }),
  );

  let result: {
    status: number | null;
    stdout?: string;
    stderr?: string;
    workerEvents?: ReturnType<typeof ingestWorkerJsonl>;
  };
  let finalization: WorkerFinalization;
  if (driverId === "fixture") {
    const workerResult = runFixtureWorker({ slice, targetPath: target.path });
    fs.writeFileSync(lastMessagePath, `${JSON.stringify(workerResult)}\n`, "utf8");
    result = {
      status: 0,
      stdout: `${JSON.stringify({ type: "fixture.worker.completed", sliceId: slice.id, actor: input.actor })}\n`,
    };
    finalization = { ok: true, structuredResultWritten: true };
  } else {
    const adapter = getWorkerDriver(driverId)!;
    const spec: WorkerRunSpec = {
      prompt,
      targetPath: target.path,
      schemaPath,
      resultPath: lastMessagePath,
      model: input.model,
      driverConfig: protocol.protocol.workers.drivers[driverId] ?? {},
    };
    const invocation = adapter.buildInvocation(spec);
    result = await spawnWorkerStreaming({
      command: invocation.command,
      args: invocation.args,
      cwd: target.path,
      jsonlPath,
      actor: input.actor,
      sliceId: slice.id,
      store: input.store,
      driver: driverId,
      classify: adapter.classifyHeartbeat?.bind(adapter),
    });
    finalization = adapter.finalize({ exitCode: result.status, stdout: result.stdout ?? "", spec });
  }

  if (driverId === "fixture") fs.writeFileSync(jsonlPath, result.stdout ?? "", "utf8");
  if (result.stderr) fs.writeFileSync(stderrPath, result.stderr, "utf8");
  const workerEvents =
    result.workerEvents ??
    ingestWorkerJsonl({
      store: input.store,
      actor: input.actor,
      sliceId: slice.id,
      driver: driverId,
      jsonl: result.stdout ?? "",
    });
  input.store.updateAgentRun(runId, {
    status: finalization.ok ? "completed" : "failed",
    sessionId: workerEvents.sessionId,
    eventsPath: jsonlPath,
    resultPath: fs.existsSync(lastMessagePath) ? lastMessagePath : undefined,
    stderrPath: result.stderr ? stderrPath : undefined,
  });

  if (fs.existsSync(lastMessagePath)) {
    input.store.insertEvidence({
      id: makeId("evidence"),
      sliceId: slice.id,
      kind: "worker_result",
      summary: input.reason === "restart" ? "Structured worker restart result" : "Structured worker result",
      ref: lastMessagePath,
      payload: { path: lastMessagePath, previousRunId: input.previousRunId },
      createdAt: new Date().toISOString(),
    });
  }
  input.store.addEvent(
    createEvent({
      actor: input.actor,
      type: "worker.completed",
      entityType: "slice",
      entityId: slice.id,
      payload: {
        exitCode: result.status,
        driver: driverId,
        ok: finalization.ok,
        structuredResultWritten: finalization.structuredResultWritten,
        failureReason: finalization.failureReason,
        costUsd: finalization.costUsd,
        runId,
        previousRunId: input.previousRunId,
        eventsPath: jsonlPath,
        resultPath: lastMessagePath,
        stderrPath: result.stderr ? stderrPath : undefined,
        workerEvents,
      },
    }),
  );
  input.store.updateSliceStatus(slice.id, finalization.ok ? "implemented" : "blocked");
  input.store.upsertHeartbeat({
    id: `heartbeat:${input.actor}`,
    actor: input.actor,
    state: finalization.ok ? "idle" : "blocked",
    detail: finalization.ok ? `${driverId} worker completed` : `${driverId} worker failed`,
    entityType: "slice",
    entityId: slice.id,
  });
  refreshCheckpoint({
    store: input.store,
    role: "worker",
    entityType: "slice",
    entityId: slice.id,
    actor: input.actor,
    reason: "Worker run completed.",
  });
  refreshCheckpoint({
    store: input.store,
    role: "recovery",
    entityType: "agent_run",
    entityId: runId,
    actor: input.actor,
    reason: input.reason === "restart" ? "Restart worker run completed." : "Worker run available for recovery context.",
  });
  return {
    sliceId: slice.id,
    runId,
    ok: finalization.ok,
    exitCode: result.status,
    eventsPath: jsonlPath,
    resultPath: lastMessagePath,
    workerEvents,
    stderr: result.stderr,
  };
}

async function executeReviewRun(input: {
  workspace: string;
  store: SwarmStore;
  sliceId: string;
  actor: string;
  driver: string;
  model?: string;
}): Promise<ReviewRunResult> {
  const slice = input.store.listSlices().find((item) => item.id === input.sliceId);
  if (!slice) throw new Error(`Slice not found: ${input.sliceId}`);
  validateSliceDispatchContract(slice);
  const target = input.store.targetById(slice.targetId);
  if (!target) throw new Error(`Target not found for slice: ${slice.targetId}`);
  if (input.driver !== "fixture" && !getWorkerDriver(input.driver)) {
    throw new Error(`Invalid reviewer driver: ${input.driver}. Expected one of: ${["fixture", ...workerDriverIds()].sort().join(", ")}.`);
  }
  const lane = input.store.listLanes().find((item) => item.id === slice.laneId);
  const artifactPath = path.join(artifactsDir(input.workspace), slice.id);
  fs.mkdirSync(artifactPath, { recursive: true });
  const runId = makeId("agentRun");
  const resultPath = path.join(artifactPath, `review-result-${runId}.json`);
  const jsonlPath = path.join(artifactPath, `review-events-${runId}.jsonl`);
  const stderrPath = path.join(artifactPath, `review-stderr-${runId}.log`);
  const schemaPath = path.join(input.workspace, "schemas", "review-result.schema.json");
  writeReviewResultSchema(schemaPath);

  const evidence = input.store.listEvidence(slice.id);
  const sourceMutationsBefore = inspectSourceMutations(slice);
  const prompt = buildReviewPrompt({
    slice,
    targetPath: target.path,
    laneName: lane?.name,
    evidence,
    sourceMutations: sourceMutationsBefore,
  });
  const now = new Date().toISOString();
  const attempt = input.store.listAgentRuns().filter((run) => run.sliceId === slice.id && run.actor === input.actor).length + 1;

  input.store.insertAgentRun({
    id: runId,
    sliceId: slice.id,
    role: "reviewer",
    entityType: "slice",
    entityId: slice.id,
    actor: input.actor,
    driver: input.driver,
    status: "running",
    attempt,
    startedAt: now,
    updatedAt: now,
  });
  input.store.upsertHeartbeat({
    id: `heartbeat:${input.actor}`,
    actor: input.actor,
    state: "verifying",
    detail: "Independent reviewer process started",
    entityType: "slice",
    entityId: slice.id,
  });
  input.store.addEvent(
    createEvent({
      actor: input.actor,
      type: "review.started",
      entityType: "slice",
      entityId: slice.id,
      payload: {
        targetPath: target.path,
        laneId: slice.laneId,
        reviewerActor: input.actor,
        driver: input.driver,
        model: input.model,
        runId,
        attempt,
        sourceMutationsBefore,
      },
    }),
  );

  let reviewFinalization: WorkerFinalization;
  let result: {
    status: number | null;
    stdout?: string;
    stderr?: string;
    workerEvents?: ReturnType<typeof ingestWorkerJsonl>;
  };
  if (input.driver === "fixture") {
    const reviewResult = runFixtureReview({
      slice,
      evidence,
      sourceMutations: sourceMutationsBefore,
    });
    fs.writeFileSync(resultPath, `${JSON.stringify(reviewResult)}\n`, "utf8");
    result = {
      status: 0,
      stdout: `${JSON.stringify({ type: "fixture.reviewer.completed", sliceId: slice.id, actor: input.actor })}\n`,
    };
    reviewFinalization = { ok: true, structuredResultWritten: true };
  } else {
    const adapter = getWorkerDriver(input.driver)!;
    const protocol = loadProtocol(target.path);
    const spec: WorkerRunSpec = {
      prompt,
      targetPath: target.path,
      schemaPath,
      resultPath,
      model: input.model,
      readOnly: true,
      resultSchema: reviewResultSchema,
      driverConfig: protocol.protocol.workers.drivers[input.driver] ?? {},
    };
    const invocation = adapter.buildInvocation(spec);
    result = await spawnWorkerStreaming({
      command: invocation.command,
      args: invocation.args,
      cwd: target.path,
      jsonlPath,
      actor: input.actor,
      sliceId: slice.id,
      store: input.store,
      driver: input.driver,
      eventPrefix: "reviewer",
      classify: adapter.classifyHeartbeat?.bind(adapter),
    });
    reviewFinalization = adapter.finalize({ exitCode: result.status, stdout: result.stdout ?? "", spec });
  }

  if (input.driver === "fixture") fs.writeFileSync(jsonlPath, result.stdout ?? "", "utf8");
  if (result.stderr) fs.writeFileSync(stderrPath, result.stderr, "utf8");
  const reviewerEvents =
    result.workerEvents ??
    ingestWorkerJsonl({
      store: input.store,
      actor: input.actor,
      sliceId: slice.id,
      driver: input.driver,
      jsonl: result.stdout ?? "",
      eventPrefix: "reviewer",
    });
  const sourceMutationsAfter = inspectSourceMutations(slice);
  const parsedReview = readReviewResultFile(resultPath);
  const runCompleted = reviewFinalization.ok && parsedReview.ok;
  input.store.updateAgentRun(runId, {
    status: runCompleted ? "completed" : "failed",
    sessionId: reviewerEvents.sessionId,
    eventsPath: jsonlPath,
    resultPath: fs.existsSync(resultPath) ? resultPath : undefined,
    stderrPath: result.stderr ? stderrPath : undefined,
  });

  let reviewEvidenceId: string | undefined;
  if (parsedReview.ok) {
    reviewEvidenceId = makeId("evidence");
    input.store.insertEvidence({
      id: reviewEvidenceId,
      sliceId: slice.id,
      kind: "review_result",
      summary: `Independent review ${parsedReview.result.status}: ${parsedReview.result.summary}`,
      ref: resultPath,
      payload: {
        path: resultPath,
        reviewResult: parsedReview.result,
        sourceMutationsBefore,
        sourceMutationsAfter,
        reviewerEvents,
      },
      createdAt: new Date().toISOString(),
    });
    applyReviewOutcome({
      store: input.store,
      slice,
      actor: input.actor,
      result: parsedReview.result,
      reviewEvidenceId,
      sourceMutationsAfter,
    });
    input.store.addEvent(
      createEvent({
        actor: input.actor,
        type: "review.completed",
        entityType: "slice",
        entityId: slice.id,
        payload: {
          exitCode: result.status,
          driver: input.driver,
          ok: reviewFinalization.ok,
          structuredResultWritten: reviewFinalization.structuredResultWritten,
          failureReason: reviewFinalization.failureReason,
          costUsd: reviewFinalization.costUsd,
          runId,
          eventsPath: jsonlPath,
          resultPath,
          stderrPath: result.stderr ? stderrPath : undefined,
          reviewerEvents,
          reviewStatus: parsedReview.result.status,
          reviewEvidenceId,
          sourceMutationsAfter,
        },
      }),
    );
  } else {
    const reason = parsedReview.reason;
    input.store.updateSliceStatus(slice.id, "blocked");
    input.store.updateDependenciesFor("slice", slice.id, "blocked");
    insertReviewEscalation(input.store, slice, input.actor, "blocker", "Reviewer output was missing or invalid.", reason);
    input.store.upsertHeartbeat({
      id: `heartbeat:${input.actor}`,
      actor: input.actor,
      state: "blocked",
      detail: reason,
      entityType: "slice",
      entityId: slice.id,
    });
    input.store.addEvent(
      createEvent({
        actor: input.actor,
        type: "review.failed",
        entityType: "slice",
        entityId: slice.id,
        payload: {
          exitCode: result.status,
          driver: input.driver,
          failureReason: reviewFinalization.failureReason,
          runId,
          eventsPath: jsonlPath,
          resultPath,
          stderrPath: result.stderr ? stderrPath : undefined,
          reviewerEvents,
          reason,
          sourceMutationsAfter,
        },
      }),
    );
  }

  refreshCheckpoint({
    store: input.store,
    role: "reviewer",
    entityType: "slice",
    entityId: slice.id,
    actor: input.actor,
    reason: parsedReview.ok ? "Reviewer run completed." : "Reviewer run failed.",
  });
  refreshCheckpoint({
    store: input.store,
    role: "recovery",
    entityType: "agent_run",
    entityId: runId,
    actor: input.actor,
    reason: "Reviewer run available for recovery context.",
  });

  return {
    sliceId: slice.id,
    runId,
    exitCode: result.status,
    eventsPath: jsonlPath,
    resultPath,
    reviewerEvents,
    reviewResult: parsedReview.ok ? parsedReview.result : undefined,
    stderr: result.stderr,
  };
}

function spawnWorkerStreaming(input: {
  command: string;
  args: string[];
  cwd: string;
  jsonlPath: string;
  actor: string;
  sliceId: string;
  entityType?: EntityType;
  entityId?: string;
  store: SwarmStore;
  driver: string;
  eventPrefix?: string;
  classify?: (event: Record<string, unknown>) => HeartbeatState | undefined;
}): Promise<WorkerStreamingResult> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(input.jsonlPath), { recursive: true });
    fs.writeFileSync(input.jsonlPath, "", "utf8");
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const ingestor = createWorkerJsonlIngestor({
      store: input.store,
      actor: input.actor,
      sliceId: input.sliceId,
      driver: input.driver,
      entityType: input.entityType,
      entityId: input.entityId,
      eventPrefix: input.eventPrefix,
      classify: input.classify,
    });
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutChunks.push(chunk);
      fs.appendFileSync(input.jsonlPath, chunk, "utf8");
      ingestor.ingest(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrChunks.push(chunk);
    });
    child.on("error", reject);
    child.on("close", (status) => {
      const workerEvents = ingestor.flush();
      resolve({
        status,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        workerEvents,
      });
    });
  });
}

function printWorkerRunResult(result: WorkerRunResult): void {
  console.log(`Worker ${result.ok ? "completed" : "failed"} for ${result.sliceId}`);
  console.log(`  run: ${result.runId}`);
  console.log(`  events: ${result.eventsPath}`);
  console.log(`  ingested events: ${result.workerEvents.eventCount}`);
  if (result.workerEvents.sessionId) console.log(`  session: ${result.workerEvents.sessionId}`);
  if (result.workerEvents.parseErrorCount > 0) console.log(`  event parse errors: ${result.workerEvents.parseErrorCount}`);
  console.log(`  result: ${result.resultPath}`);
  if (result.stderr?.trim()) console.error(result.stderr.trim());
}

function printReviewRunResult(result: ReviewRunResult): void {
  const reviewStatus = result.reviewResult?.status ?? "invalid";
  console.log(`Review ${result.exitCode === 0 && result.reviewResult ? reviewStatus : "failed"} for ${result.sliceId}`);
  console.log(`  run: ${result.runId}`);
  console.log(`  events: ${result.eventsPath}`);
  console.log(`  ingested events: ${result.reviewerEvents.eventCount}`);
  if (result.reviewerEvents.sessionId) console.log(`  session: ${result.reviewerEvents.sessionId}`);
  if (result.reviewerEvents.parseErrorCount > 0) console.log(`  event parse errors: ${result.reviewerEvents.parseErrorCount}`);
  console.log(`  result: ${result.resultPath}`);
  if (result.reviewResult) console.log(`  recommendation: ${result.reviewResult.recommendation}`);
  if (result.stderr?.trim()) console.error(result.stderr.trim());
}

function printOverseerRunResult(result: OverseerRunResult): void {
  const status = result.decision?.status ?? "invalid";
  console.log(`Overseer ${result.exitCode === 0 && result.decision ? status : "failed"} for ${result.scenario}`);
  console.log(`  run: ${result.runId}`);
  console.log(`  events: ${result.eventsPath}`);
  console.log(`  ingested events: ${result.overseerEvents.eventCount}`);
  if (result.overseerEvents.sessionId) console.log(`  session: ${result.overseerEvents.sessionId}`);
  if (result.overseerEvents.parseErrorCount > 0) console.log(`  event parse errors: ${result.overseerEvents.parseErrorCount}`);
  console.log(`  result: ${result.resultPath}`);
  if (result.decision) {
    console.log(`  next: ${result.decision.nextAction}`);
    if (result.decision.recommendedCommands.length > 0) {
      console.log(`  recommended commands: ${result.decision.recommendedCommands.length}`);
    }
  }
  if (result.commandResults) {
    const executed = result.commandResults.filter((item) => item.status === "executed").length;
    const blocked = result.commandResults.filter((item) => item.status === "blocked").length;
    const failed = result.commandResults.filter((item) => item.status === "failed").length;
    console.log(`  command execution: executed ${executed}, blocked ${blocked}, failed ${failed}`);
  }
  if (result.stderr?.trim()) console.error(result.stderr.trim());
}

function printStatus(): void {
  const workspace = resolveWorkspace();
  ensureInitialized(workspace);
  const store = new SwarmStore(workspace);
  try {
    const targets = store.listTargets();
    const sources = store.listSources();
    const lanes = store.listLanes();
    const slices = store.listSlices();
    const leases = store.listLeases();
    const heartbeats = store.listHeartbeats();
    const activeEscalations = store.listEscalations("active");
    const events = store.recentEvents(5);

    console.log("Harness status");
    console.log(`Workspace: ${workspace}`);
    console.log(`Run mode: ${currentRunMode(store)}`);
    console.log(`Targets: ${targets.length}`);
    for (const target of targets) {
      console.log(`  - ${target.name} (${target.id}) ${target.path}`);
    }
    console.log(`Sources: ${sources.length}`);
    for (const source of sources) {
      console.log(`  - ${source.title} (${source.id}) ${source.uri}`);
    }
    console.log(`Lanes: ${lanes.length}`);
    for (const lane of lanes) {
      const activeLeases = leases.filter((lease) => lease.laneId === lane.id && lease.status === "active");
      const activeSlices = slices.filter((slice) => slice.laneId === lane.id && !["accepted", "closed"].includes(slice.status));
      console.log(`  - ${lane.name} (${lane.id})`);
      console.log(`    state: ${lane.state}`);
      console.log(`    purpose: ${lane.purpose}`);
      console.log(`    focus: ${lane.focusLabels.join(", ")}`);
      console.log(`    active slices: ${activeSlices.length}`);
      console.log(`    active leases: ${activeLeases.map((lease) => lease.frAcRef).join(", ") || "none"}`);
    }
    console.log(`Slices: ${slices.length}`);
    for (const slice of slices) {
      console.log(`  - ${slice.title} (${slice.id}) [${slice.status}]`);
    }
    console.log(`Heartbeats: ${heartbeats.length}`);
    for (const heartbeat of heartbeats.slice(0, 5)) {
      console.log(
        `  - ${heartbeat.actor}: ${heartbeat.state} ${heartbeat.entityType ?? "entity"}:${heartbeat.entityId ?? "-"} (${elapsedSince(heartbeat.timestamp)})`,
      );
      if (heartbeat.detail) console.log(`    ${heartbeat.detail}`);
    }
    console.log(`Active escalations: ${activeEscalations.length}`);
    for (const escalation of activeEscalations) {
      console.log(`  - ${escalation.level} ${escalation.entityType}:${escalation.entityId} ${escalation.message}`);
    }
    console.log("Recent events:");
    for (const event of events) {
      console.log(`  - ${event.timestamp} ${event.actor} ${event.type} ${event.entityType}:${event.entityId}`);
    }
  } finally {
    store.close();
  }
}

function createWebViewerServer(input: { workspace: string; defaultEventCount: number; historyRoot: string }): http.Server {
  return http.createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      if (request.method !== "GET") {
        sendText(response, 405, "Method not allowed", "text/plain");
        return;
      }

      if (requestUrl.pathname === "/") {
        sendText(response, 200, WEB_VIEWER_HTML, "text/html; charset=utf-8");
        return;
      }
      if (requestUrl.pathname === "/assets/styles.css") {
        sendText(response, 200, WEB_VIEWER_CSS, "text/css; charset=utf-8");
        return;
      }
      if (requestUrl.pathname === "/assets/app.js") {
        sendText(response, 200, WEB_VIEWER_JS, "text/javascript; charset=utf-8");
        return;
      }
      if (requestUrl.pathname === "/api/history/runs") {
        sendJson(response, listLiveRunHistory(input.historyRoot));
        return;
      }
      if (requestUrl.pathname.startsWith("/api/history/run/")) {
        const runId = decodeURIComponent(requestUrl.pathname.slice("/api/history/run/".length));
        const detail = loadLiveRunHistoryDetail(input.historyRoot, runId);
        if (!detail) {
          sendJson(response, { error: "Archived run not found" }, 404);
          return;
        }
        sendJson(response, detail);
        return;
      }
      if (requestUrl.pathname === "/api/history/compare") {
        const comparison = compareLiveRunHistory(
          input.historyRoot,
          requestUrl.searchParams.get("left") ?? undefined,
          requestUrl.searchParams.get("right") ?? undefined,
        );
        if (!comparison) {
          sendJson(response, { error: "Need at least two archived runs to compare" }, 404);
          return;
        }
        sendJson(response, comparison);
        return;
      }

      const store = new SwarmStore(input.workspace);
      try {
        if (requestUrl.pathname === "/api/snapshot") {
          const events = parseOptionalPositiveInteger(requestUrl.searchParams.get("events")) ?? input.defaultEventCount;
          sendJson(response, buildObservabilitySnapshot(store, input.workspace, events));
          return;
        }
        if (requestUrl.pathname.startsWith("/api/timeline/")) {
          const entityId = decodeURIComponent(requestUrl.pathname.slice("/api/timeline/".length));
          if (!entityId) {
            sendJson(response, { error: "Missing timeline entity id" }, 400);
            return;
          }
          sendJson(response, buildTimeline(store, entityId));
          return;
        }
        if (requestUrl.pathname === "/api/graph") {
          sendJson(response, buildGraph(store));
          return;
        }
        if (requestUrl.pathname.startsWith("/api/source/")) {
          const selector = decodeURIComponent(requestUrl.pathname.slice("/api/source/".length));
          const source = selector ? findSource(store, selector) : undefined;
          if (!source) {
            sendJson(response, { error: "Source not found" }, 404);
            return;
          }
          sendJson(response, {
            source,
            markdown: readSourceText(source),
          });
          return;
        }
        if (requestUrl.pathname === "/api/search/specs") {
          const query = requestUrl.searchParams.get("q") ?? "";
          const limit = parseOptionalPositiveInteger(requestUrl.searchParams.get("limit")) ?? 8;
          const domain = requestUrl.searchParams.get("domain") ?? undefined;
          const tag = requestUrl.searchParams.get("tag") ?? undefined;
          const source = requestUrl.searchParams.get("source") ?? undefined;
          const matches = query.trim()
            ? searchSpecSections(store, query, { domain, tag, source, limit }).map((match) => ({
                source: {
                  id: match.source.id,
                  title: match.source.title,
                  uri: match.source.uri,
                  domain: sourceDomain(match.source),
                  tags: sourceTags(match.source),
                  priority: sourcePriority(match.source),
                },
                section: match.section,
                score: match.score,
                snippet: match.snippet,
              }))
            : [];
          const selectedSource = source ? findSource(store, source) : undefined;
          sendJson(response, { query, source: selectedSource ? { id: selectedSource.id, title: selectedSource.title } : undefined, matches });
          return;
        }
        if (requestUrl.pathname.startsWith("/api/report/")) {
          const sliceId = decodeURIComponent(requestUrl.pathname.slice("/api/report/".length));
          if (!sliceId) {
            sendJson(response, { error: "Missing report slice id" }, 400);
            return;
          }
          sendText(response, 200, buildSliceReport(store, sliceId), "text/markdown; charset=utf-8");
          return;
        }
        if (requestUrl.pathname.startsWith("/api/artifacts/")) {
          const artifactPath = decodeURIComponent(requestUrl.pathname.slice("/api/artifacts/".length));
          serveArtifact(response, input.workspace, artifactPath);
          return;
        }
      } finally {
        store.close();
      }

      sendText(response, 404, "Not found", "text/plain");
    } catch (error) {
      sendJson(response, { error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });
}

function sendJson(response: ServerResponse, value: unknown, statusCode = 200): void {
  sendText(response, statusCode, `${JSON.stringify(value, null, 2)}\n`, "application/json; charset=utf-8");
}

function sendText(response: ServerResponse, statusCode: number, body: string, contentType: string): void {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  response.end(body);
}

function serveArtifact(response: ServerResponse, workspace: string, relativePath: string): void {
  const root = artifactsDir(workspace);
  const resolved = path.resolve(root, relativePath);
  if (!resolved.toLowerCase().startsWith(`${path.resolve(root).toLowerCase()}${path.sep}`)) {
    sendJson(response, { error: "Artifact path escapes workspace artifacts directory" }, 400);
    return;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    sendJson(response, { error: "Artifact not found" }, 404);
    return;
  }
  sendText(response, 200, fs.readFileSync(resolved, "utf8"), contentTypeForPath(resolved));
}

function contentTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".json" || ext === ".jsonl") return "application/json; charset=utf-8";
  if (ext === ".log" || ext === ".txt") return "text/plain; charset=utf-8";
  if (ext === ".md") return "text/markdown; charset=utf-8";
  return "application/octet-stream";
}

type LiveRunHistoryRecord = {
  runId: string;
  scenario?: string;
  runMode?: string;
  phase?: string;
  driver?: string;
  faultMode?: string;
  generatedAt?: string;
  startedAt?: string;
  finalOutcome?: string;
  finalReason?: string;
  classificationCode?: string;
  classificationSeverity?: string;
  sliceId?: string;
  finalSliceStatus?: string;
  counts?: Record<string, number>;
  summary: string;
  artifactIndex: string;
  artifactIndexMarkdown?: string;
  originalSummary?: string;
  originalArtifactIndex?: string;
  originalArtifactIndexMarkdown?: string;
};

function defaultLiveRunHistoryRoot(workspace: string): string {
  const resolved = path.resolve(workspace);
  const parent = path.dirname(resolved);
  if (path.basename(parent).toLowerCase() === ".swarm-demo") {
    return path.join(parent, "live-agent-run-history");
  }
  return path.join(swarmDir(resolved), "run-history");
}

function listLiveRunHistory(historyRoot: string): { historyRoot: string; exists: boolean; runs: LiveRunHistoryRecord[]; updatedAt?: string } {
  const root = path.resolve(historyRoot);
  const indexPath = path.join(root, "runs.json");
  if (!fs.existsSync(indexPath)) return { historyRoot: root, exists: false, runs: [] };
  const index = safeReadHistoryJson(root, indexPath) as { updatedAt?: string; runs?: LiveRunHistoryRecord[] };
  const runs = (index.runs ?? []).map((run) => ({ ...run })).sort((left, right) => String(left.generatedAt ?? "").localeCompare(String(right.generatedAt ?? "")));
  return { historyRoot: root, exists: true, updatedAt: index.updatedAt, runs };
}

function loadLiveRunHistoryDetail(
  historyRoot: string,
  runId: string,
): { historyRoot: string; record: LiveRunHistoryRecord; summary: Record<string, unknown>; artifactIndex: Record<string, unknown>; artifactIndexMarkdown?: string } | undefined {
  const root = path.resolve(historyRoot);
  const record = listLiveRunHistory(root).runs.find((run) => run.runId === runId);
  if (!record) return undefined;
  return {
    historyRoot: root,
    record,
    summary: safeReadHistoryJson(root, record.summary) as Record<string, unknown>,
    artifactIndex: safeReadHistoryJson(root, record.artifactIndex) as Record<string, unknown>,
    artifactIndexMarkdown: record.artifactIndexMarkdown ? safeReadHistoryText(root, record.artifactIndexMarkdown) : undefined,
  };
}

function compareLiveRunHistory(historyRoot: string, leftId?: string, rightId?: string): Record<string, unknown> | undefined {
  const history = listLiveRunHistory(historyRoot);
  if (history.runs.length < 2 && (!leftId || !rightId)) return undefined;
  const selected = selectHistoryRuns(history.runs, leftId, rightId);
  if (!selected) return undefined;
  const leftDetail = loadLiveRunHistoryDetail(history.historyRoot, selected.left.runId);
  const rightDetail = loadLiveRunHistoryDetail(history.historyRoot, selected.right.runId);
  if (!leftDetail || !rightDetail) return undefined;
  const left = summarizeHistoryRun(leftDetail.summary, selected.left);
  const right = summarizeHistoryRun(rightDetail.summary, selected.right);
  const countKeys = ["turns", "verifyRuns", "lanes", "slices", "agentRuns", "evidence", "activeEscalations", "graphNodes", "graphEdges", "timelineItems"];
  const countDeltas = Object.fromEntries(countKeys.map((key) => [key, (right.counts[key] ?? 0) - (left.counts[key] ?? 0)]));
  const changes = {
    finalOutcomeChanged: left.finalOutcome !== right.finalOutcome,
    classificationChanged: left.classification.code !== right.classification.code,
    faultModeChanged: left.faultMode !== right.faultMode,
    phaseChanged: left.phase !== right.phase,
    finalSliceStatusChanged: left.finalSliceStatus !== right.finalSliceStatus,
  };
  return {
    generatedAt: new Date().toISOString(),
    historyRoot: history.historyRoot,
    mode: selected.mode,
    left,
    right,
    changes,
    deltas: {
      counts: countDeltas,
      finalOutcome: `${left.finalOutcome} -> ${right.finalOutcome}`,
      classification: `${left.classification.code} -> ${right.classification.code}`,
      faultMode: `${left.faultMode} -> ${right.faultMode}`,
    },
    artifacts: {
      leftSummary: selected.left.summary,
      rightSummary: selected.right.summary,
      leftArtifactIndex: selected.left.artifactIndex,
      rightArtifactIndex: selected.right.artifactIndex,
    },
    interpretation: interpretHistoryComparison(left, right, changes, countDeltas),
  };
}

function selectHistoryRuns(
  runs: LiveRunHistoryRecord[],
  leftId?: string,
  rightId?: string,
): { left: LiveRunHistoryRecord; right: LiveRunHistoryRecord; mode: "latest-two" | "explicit" } | undefined {
  const sorted = [...runs].sort((left, right) => String(left.generatedAt ?? "").localeCompare(String(right.generatedAt ?? "")));
  if (!leftId && !rightId) {
    const left = sorted.at(-2);
    const right = sorted.at(-1);
    return left && right ? { left, right, mode: "latest-two" } : undefined;
  }
  if (!leftId || !rightId) return undefined;
  const left = sorted.find((run) => run.runId === leftId);
  const right = sorted.find((run) => run.runId === rightId);
  return left && right ? { left, right, mode: "explicit" } : undefined;
}

function summarizeHistoryRun(summary: Record<string, unknown>, record: LiveRunHistoryRecord) {
  const outcomeClassification = objectValue(summary.outcomeClassification);
  const fault = objectValue(summary.fault);
  return {
    runId: stringValue(summary.runId) ?? record.runId,
    scenario: stringValue(summary.scenario) ?? record.scenario,
    runMode: stringValue(summary.runMode) ?? record.runMode,
    phase: stringValue(summary.phase) ?? record.phase,
    driver: stringValue(summary.driver) ?? record.driver,
    faultMode: stringValue(fault?.mode) ?? record.faultMode,
    startedAt: stringValue(summary.startedAt) ?? record.startedAt,
    generatedAt: stringValue(summary.generatedAt) ?? record.generatedAt,
    finalOutcome: stringValue(summary.finalOutcome) ?? record.finalOutcome ?? "unknown",
    finalReason: stringValue(summary.finalReason) ?? record.finalReason,
    classification: {
      code: stringValue(outcomeClassification?.code) ?? record.classificationCode ?? "unknown",
      severity: stringValue(outcomeClassification?.severity) ?? record.classificationSeverity ?? "unknown",
      explanation: stringValue(outcomeClassification?.explanation),
    },
    sliceId: stringValue(summary.sliceId) ?? record.sliceId,
    finalSliceStatus: stringValue(summary.finalSliceStatus) ?? record.finalSliceStatus,
    counts: pickComparableHistoryCounts(objectValue(summary.counts) ?? record.counts),
  };
}

function pickComparableHistoryCounts(counts: Record<string, unknown> | Record<string, number> | undefined): Record<string, number> {
  const keys = ["turns", "verifyRuns", "lanes", "slices", "agentRuns", "evidence", "activeEscalations", "graphNodes", "graphEdges", "timelineItems"];
  return Object.fromEntries(keys.map((key) => [key, numberValue(counts?.[key]) ?? 0]));
}

function interpretHistoryComparison(
  left: ReturnType<typeof summarizeHistoryRun>,
  right: ReturnType<typeof summarizeHistoryRun>,
  changes: Record<string, boolean>,
  countDeltas: Record<string, number>,
): string {
  if (left.finalOutcome !== "accepted" && right.finalOutcome === "accepted") return "Run outcome improved to accepted.";
  if (left.finalOutcome === "accepted" && right.finalOutcome !== "accepted") {
    return "Run outcome moved away from accepted; inspect classification and blockers before treating this as progress.";
  }
  if (changes.classificationChanged) return "Outcome classification changed; inspect the archived summaries for the new stop reason.";
  if (Object.values(countDeltas).some((value) => value !== 0)) return "Lifecycle shape changed while outcome stayed comparable; inspect count deltas and artifact indexes.";
  return "No material outcome or lifecycle count changes detected.";
}

function safeReadHistoryJson(historyRoot: string, filePath: string): unknown {
  return JSON.parse(safeReadHistoryText(historyRoot, filePath));
}

function safeReadHistoryText(historyRoot: string, filePath: string): string {
  const root = path.resolve(historyRoot);
  const resolved = path.resolve(filePath);
  if (!resolved.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`)) {
    throw new Error(`Archived run path escapes history root: ${resolved}`);
  }
  return fs.readFileSync(resolved, "utf8");
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseOptionalPositiveInteger(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function buildSliceReport(store: SwarmStore, sliceId: string): string {
  const slice = store.listSlices().find((item) => item.id === sliceId);
  if (!slice) throw new Error(`Slice not found: ${sliceId}`);
  const lane = store.listLanes().find((item) => item.id === slice.laneId);
  const leases = store.listLeases().filter((lease) => lease.sliceId === slice.id);
  const evidence = store.listEvidence(slice.id);
  const escalations = store.listEscalations("active").filter((item) => item.entityId === slice.id);
  const frAcResults = latestFrAcResults(evidence);
  const reviewResult = latestReviewResult(evidence);
  const lines = [
    `# Slice Report: ${slice.title}`,
    "",
    `Status: ${slice.status}`,
    `Slice: ${slice.id}`,
    `Lane: ${lane ? `${lane.name} (${lane.id})` : slice.laneId}`,
    `Delivery question: ${slice.deliveryQuestion}`,
    `Work package: ${slice.workPackageType}`,
    `Minimum meaningful outcome: ${slice.minimumMeaningfulOutcome}`,
    ...(slice.acSizedExceptionReason ? [`AC-sized exception: ${slice.acSizedExceptionReason}`] : []),
    "",
    "Source refs:",
    ...slice.sourceRefs.map((source) => `- ${source.title ?? source.uri} (${source.uri})`),
    "",
    "FR/AC coverage:",
    ...slice.frAcRefs.map((ref) => {
      const result = frAcResults.find((item) => item.ref === ref);
      return result
        ? `- ${ref}: ${result.status} (${result.proof})`
        : `- ${ref}: unverified`;
    }),
    "",
    "Expected evidence:",
    ...slice.expectedEvidence.map((item) => `- ${item}`),
    "",
    "Unblock targets:",
    ...(slice.unblockTargets.length > 0 ? slice.unblockTargets.map((item) => `- ${item}`) : ["- none declared"]),
    "",
    "Leases:",
    ...(leases.length > 0 ? leases.map((lease) => `- ${lease.frAcRef}: ${lease.status}`) : ["- none"]),
    "",
    "Evidence:",
    ...(evidence.length > 0 ? evidence.map((item) => `- ${item.kind}: ${item.summary}${item.ref ? ` (${item.ref})` : ""}`) : ["- none"]),
    "",
    "Latest review:",
    ...(reviewResult
      ? [
          `- status: ${reviewResult.status}`,
          `- summary: ${reviewResult.summary}`,
          `- stub/hardcode risk: ${reviewResult.stubOrHardcodeRisk}`,
          `- recommendation: ${reviewResult.recommendation}`,
          ...(reviewResult.requiredFixes.length > 0
            ? reviewResult.requiredFixes.map((item) => `- required fix: ${item}`)
            : ["- required fixes: none"]),
          ...reviewResult.frAcFindings.map((finding) => `- ${finding.ref}: ${finding.status} (${finding.finding})`),
        ]
      : ["- none"]),
    "",
    "Active escalations:",
    ...(escalations.length > 0 ? escalations.map((escalation) => `- ${escalation.level}: ${escalation.message}`) : ["- none"]),
    "",
    "Verification requirements:",
    ...slice.verificationRequirements.map((req) => `- ${req}`),
  ];
  return lines.join("\n");
}

function latestFrAcResults(evidence: Array<ReturnType<SwarmStore["listEvidence"]>[number]>): FrAcVerificationResult[] {
  const commandEvidence = evidence
    .filter((item) => item.kind === "command" && Array.isArray(item.payload.frAcResults))
    .at(-1);
  if (!commandEvidence) return [];
  return commandEvidence.payload.frAcResults as unknown as FrAcVerificationResult[];
}

function buildObservabilitySnapshot(store: SwarmStore, workspace: string, eventCount: number) {
  const slices = store.listSlices();
  const leases = store.listLeases();
  const evidence = store.listEvidence();
  return {
    workspace,
    runMode: currentRunMode(store),
    generatedAt: new Date().toISOString(),
    targets: store.listTargets(),
    sources: store.listSources(),
    domains: buildDomainSummaries(store),
    lanes: store.listLanes().map((lane) => ({
      ...lane,
      activeLeases: leases.filter((lease) => lease.laneId === lane.id && lease.status === "active").map((lease) => lease.frAcRef),
    })),
    slices: slices.map((slice) => ({
      ...slice,
      leases: leases.filter((lease) => lease.sliceId === slice.id),
      evidence: evidence.filter((item) => item.sliceId === slice.id),
      frAcResults: latestFrAcResults(evidence.filter((item) => item.sliceId === slice.id)),
      reviewResult: latestReviewResult(evidence.filter((item) => item.sliceId === slice.id)),
      agentRuns: store.listAgentRuns().filter((run) => run.sliceId === slice.id),
    })),
    dependencies: store.listDependencies().map((dependency) => ({
      ...dependency,
      status: currentDependencyStatus(store, dependency),
    })),
    agentRuns: store.listAgentRuns(),
    heartbeats: store.listHeartbeats(),
    activeEscalations: store.listEscalations("active"),
    checkpoints: store.listCheckpoints(),
    recentEvents: store.recentEvents(eventCount),
  };
}

type WatchView = "all" | "lanes" | "agents" | "blockers" | "events";

function renderWatchFrame(
  snapshot: ReturnType<typeof buildObservabilitySnapshot>,
  options: { staleAfterSeconds: number; view: WatchView },
): string {
  const activeSlices = snapshot.slices.filter((slice) => !["accepted", "closed"].includes(slice.status));
  const blockedDependencies = snapshot.dependencies.filter((dependency) => dependency.status === "blocked");
  const runningAgentRuns = snapshot.agentRuns.filter((run) => run.status === "running");
  const staleAgentRuns = staleRunningAgentRuns(snapshot, options.staleAfterSeconds);
  const sliceStatusCounts = countBy(snapshot.slices.map((slice) => slice.status));
  const lines = [
    "Agent Swarm Watch",
    `Generated: ${snapshot.generatedAt}`,
    `Workspace: ${snapshot.workspace}`,
    `Run mode: ${snapshot.runMode}`,
    `View: ${options.view} | Stale threshold: ${options.staleAfterSeconds}s`,
    "",
    `Targets ${snapshot.targets.length} | Sources ${snapshot.sources.length} | Lanes ${snapshot.lanes.length} | Slices ${snapshot.slices.length} | Active ${activeSlices.length}`,
    `Slice states: ${formatCounts(sliceStatusCounts) || "none"}`,
    `Agent runs: ${snapshot.agentRuns.length} | Running: ${runningAgentRuns.length} | Stale candidates: ${staleAgentRuns.length}`,
    `Active escalations: ${snapshot.activeEscalations.length} | Blocked dependencies: ${blockedDependencies.length}`,
  ];

  if (shouldRender(options.view, "lanes")) renderLaneSection(lines, snapshot, activeSlices);
  if (shouldRender(options.view, "agents")) renderAgentSection(lines, snapshot, options.staleAfterSeconds);
  if (shouldRender(options.view, "blockers")) renderBlockerSection(lines, snapshot, blockedDependencies, staleAgentRuns);
  if (shouldRender(options.view, "events")) renderEventSection(lines, snapshot);
  renderActionSection(lines, options.view, staleAgentRuns.length);
  return lines.join("\n");
}

function renderLaneSection(
  lines: string[],
  snapshot: ReturnType<typeof buildObservabilitySnapshot>,
  activeSlices: ReturnType<typeof buildObservabilitySnapshot>["slices"],
): void {
  lines.push("", "Lanes");
  if (snapshot.lanes.length === 0) lines.push("  none");
  for (const lane of snapshot.lanes) {
    const laneSlices = snapshot.slices.filter((slice) => slice.laneId === lane.id);
    const liveSlices = laneSlices.filter((slice) => !["accepted", "closed"].includes(slice.status));
    lines.push(`  ${lane.name} (${lane.id}) [${lane.state}]`);
    lines.push(`    purpose: ${lane.purpose}`);
    lines.push(`    focus: ${lane.focusLabels.join(", ") || "none"}`);
    lines.push(`    active slices: ${liveSlices.length}; active leases: ${lane.activeLeases.join(", ") || "none"}`);
  }

  lines.push("", "Active Work");
  if (activeSlices.length === 0) lines.push("  none");
  for (const slice of activeSlices) {
    const lane = snapshot.lanes.find((item) => item.id === slice.laneId);
    const leaseSummary = slice.leases.map((lease) => `${lease.frAcRef}:${lease.status}`).join(", ") || "no leases";
    lines.push(`  ${slice.id} [${slice.status}] ${slice.title}`);
    lines.push(`    lane: ${lane?.name ?? slice.laneId}`);
    lines.push(`    refs: ${leaseSummary}`);
  }
}

function renderAgentSection(
  lines: string[],
  snapshot: ReturnType<typeof buildObservabilitySnapshot>,
  staleAfterSeconds: number,
): void {
  lines.push("", "Heartbeats");
  if (snapshot.heartbeats.length === 0) lines.push("  none");
  for (const heartbeat of snapshot.heartbeats.slice(0, 8)) {
    const ageMs = Date.now() - Date.parse(heartbeat.timestamp);
    const stale = ageMs >= staleAfterSeconds * 1000;
    lines.push(
      `  ${heartbeat.actor}: ${heartbeat.state}${stale ? " STALE" : ""} ${heartbeat.entityType ?? "entity"}:${heartbeat.entityId ?? "-"} (${elapsedSince(heartbeat.timestamp)})`,
    );
    if (heartbeat.detail) lines.push(`    ${heartbeat.detail}`);
  }

  lines.push("", "Agent Runs");
  if (snapshot.agentRuns.length === 0) lines.push("  none");
  for (const run of snapshot.agentRuns.slice(-8).reverse()) {
    const entityType = run.entityType ?? "slice";
    const entityId = run.entityId ?? run.sliceId;
    lines.push(`  ${run.id} ${run.actor} ${run.role ?? "agent"} ${run.driver} [${run.status}] ${entityType}:${entityId} attempt:${run.attempt}`);
    if (run.sessionId) lines.push(`    session: ${run.sessionId}`);
    if (run.eventsPath) lines.push(`    events: ${run.eventsPath}`);
  }
}

function renderBlockerSection(
  lines: string[],
  snapshot: ReturnType<typeof buildObservabilitySnapshot>,
  blockedDependencies: ReturnType<typeof buildObservabilitySnapshot>["dependencies"],
  staleAgentRuns: ReturnType<typeof buildObservabilitySnapshot>["agentRuns"],
): void {
  lines.push("", "Blockers");
  if (snapshot.activeEscalations.length === 0 && blockedDependencies.length === 0 && staleAgentRuns.length === 0) lines.push("  none");
  for (const escalation of snapshot.activeEscalations) {
    lines.push(`  escalation ${escalation.level} ${escalation.entityType}:${escalation.entityId} - ${escalation.message}`);
  }
  for (const dependency of blockedDependencies.slice(0, 8)) {
    lines.push(`  dependency ${dependency.target} -> ${dependency.fromType}:${dependency.fromId} - ${dependency.reason}`);
  }
  for (const run of staleAgentRuns.slice(0, 8)) {
    lines.push(`  stale run ${run.id} actor:${run.actor} ${(run.entityType ?? "slice")}:${run.entityId ?? run.sliceId}`);
  }
}

function renderEventSection(lines: string[], snapshot: ReturnType<typeof buildObservabilitySnapshot>): void {
  lines.push("", "Recent Events");
  if (snapshot.recentEvents.length === 0) lines.push("  none");
  for (const event of snapshot.recentEvents) {
    lines.push(`  ${event.timestamp} ${event.actor} ${event.type} ${event.entityType}:${event.entityId}`);
  }
}

function renderActionSection(lines: string[], view: WatchView, staleCount: number): void {
  lines.push("", "Operator Actions");
  lines.push("  watch views: --view all|lanes|agents|blockers|events");
  if (staleCount > 0) lines.push("  stale runs: swarm recovery scan --mark-stale");
  lines.push("  recovery: swarm recovery scan --stale-after 300");
  lines.push("  details: swarm timeline <slice-id> --json | swarm graph --format dot");
  lines.push(`  refresh: Ctrl+C to exit${view === "all" ? "" : " | --view all to restore full frame"}`);
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}

function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}`)
    .join(", ");
}

function defaultStaleAfterForStore(store: SwarmStore): number {
  const target = store.listTargets()[0];
  return loadProtocol(target?.path).protocol.planning.heartbeat.defaultStaleAfterSeconds;
}

function parseWatchView(value: string): WatchView {
  const allowed = new Set(["all", "lanes", "agents", "blockers", "events"]);
  if (!allowed.has(value)) throw new Error(`Invalid watch view: ${value}. Expected all, lanes, agents, blockers, or events.`);
  return value as WatchView;
}

function shouldRender(current: WatchView, section: Exclude<WatchView, "all">): boolean {
  return current === "all" || current === section;
}

function staleRunningAgentRuns(
  snapshot: ReturnType<typeof buildObservabilitySnapshot>,
  staleAfterSeconds: number,
): ReturnType<typeof buildObservabilitySnapshot>["agentRuns"] {
  const now = Date.now();
  const staleAfterMs = staleAfterSeconds * 1000;
  return snapshot.agentRuns.filter((run) => {
    if (run.status !== "running") return false;
    const entityId = run.entityId ?? run.sliceId;
    const heartbeat = snapshot.heartbeats.find((item) => item.actor === run.actor && item.entityId === entityId);
    return now - Date.parse(heartbeat?.timestamp ?? run.updatedAt) >= staleAfterMs;
  });
}

function findStaleAgentRuns(store: SwarmStore, staleAfterSeconds: number): Array<{
  run: ReturnType<SwarmStore["listAgentRuns"]>[number];
  heartbeat?: ReturnType<SwarmStore["listHeartbeats"]>[number];
  ageMs: number;
}> {
  const now = Date.now();
  const staleAfterMs = staleAfterSeconds * 1000;
  const heartbeats = store.listHeartbeats();
  return store
    .listAgentRuns("running")
    .map((run) => {
      const entityId = run.entityId ?? run.sliceId;
      const heartbeat = heartbeats.find((item) => item.actor === run.actor && item.entityId === entityId);
      const timestamp = heartbeat?.timestamp ?? run.updatedAt;
      return {
        run,
        heartbeat,
        ageMs: now - Date.parse(timestamp),
      };
    })
    .filter((item) => item.ageMs >= staleAfterMs);
}

function formatDuration(ms: number): string {
  const seconds = Math.max(Math.floor(ms / 1000), 0);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function parseEscalationLevel(value: string): "info" | "warning" | "blocker" | "human_required" | "critical" {
  const allowed = new Set(["info", "warning", "blocker", "human_required", "critical"]);
  if (!allowed.has(value)) {
    throw new Error(`Invalid escalation level: ${value}`);
  }
  return value as "info" | "warning" | "blocker" | "human_required" | "critical";
}

function parseCheckpointRole(value: string): CheckpointRole {
  const allowed = new Set(["planner", "worker", "verifier", "reviewer", "recovery", "overseer"]);
  if (!allowed.has(value)) {
    throw new Error(`Invalid checkpoint role: ${value}`);
  }
  return value as CheckpointRole;
}

function parseEntityType(value: string): ReturnType<typeof createEvent>["entityType"] {
  const allowed = new Set([
    "harness",
    "source",
    "target",
    "lane",
    "slice",
    "lease",
    "dependency",
    "agent_run",
    "heartbeat",
    "escalation",
    "evidence",
  ]);
  if (!allowed.has(value)) {
    throw new Error(`Invalid entity type: ${value}`);
  }
  return value as ReturnType<typeof createEvent>["entityType"];
}

function parseEntitySelector(value: string): { entityType: EntityType; entityId: string } {
  const match = /^([^:]+):(.+)$/.exec(value);
  if (!match) throw new Error(`Invalid entity selector: ${value}. Expected <type>:<id>.`);
  return {
    entityType: parseEntityType(match[1]),
    entityId: match[2],
  };
}

function ensureEntityExists(store: SwarmStore, entityType: EntityType, entityId: string): void {
  const exists =
    (entityType === "slice" && store.listSlices().some((item) => item.id === entityId)) ||
    (entityType === "lane" && store.listLanes().some((item) => item.id === entityId)) ||
    (entityType === "agent_run" && store.listAgentRuns().some((item) => item.id === entityId)) ||
    (entityType === "target" && store.listTargets().some((item) => item.id === entityId)) ||
    (entityType === "source" && store.listSources().some((item) => item.id === entityId)) ||
    (entityType === "escalation" && store.listEscalations().some((item) => item.id === entityId)) ||
    (entityType === "dependency" && store.listDependencies().some((item) => item.id === entityId)) ||
    (entityType === "evidence" && store.listEvidence().some((item) => item.id === entityId)) ||
    entityType === "harness";
  if (!exists) throw new Error(`Entity not found: ${entityType}:${entityId}`);
}

function renderCheckpoint(checkpoint: CheckpointRecord): string {
  const lines = [
    `# Checkpoint ${checkpoint.id}`,
    "",
    `Role: ${checkpoint.role}`,
    `Entity: ${checkpoint.entityType}:${checkpoint.entityId}`,
    `Updated: ${checkpoint.updatedAt}`,
    `Created by: ${checkpoint.createdBy}`,
    "",
    "Summary:",
    checkpoint.summary,
    "",
    "Payload:",
    JSON.stringify(checkpoint.payload, null, 2),
  ];
  return lines.join("\n");
}

function elapsedSince(timestamp: string): string {
  const elapsedMs = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "just now";
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function trimOutput(value: string, maxLength = 4000): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}\n... truncated ...`;
}

function parseCsv(value?: string): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got ${value}`);
  }
  return parsed;
}

function parsePort(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Expected a port between 0 and 65535, got ${value}`);
  }
  return parsed;
}

function listSourceFiles(dirInput: string): string[] {
  const root = path.resolve(dirInput);
  if (!fs.existsSync(root)) throw new Error(`Source directory does not exist: ${root}`);
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) throw new Error(`Source path is not a directory: ${root}`);
  const allowed = new Set([".md", ".markdown", ".txt"]);
  const results: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".swarm") continue;
        visit(fullPath);
        continue;
      }
      if (entry.isFile() && allowed.has(path.extname(entry.name).toLowerCase())) results.push(fullPath);
    }
  };
  visit(root);
  return results.sort((a, b) => a.localeCompare(b));
}

function findSource(store: SwarmStore, selector: string) {
  const raw = selector.toLowerCase();
  const normalized = path.resolve(selector).toLowerCase();
  return store.listSources().find(
    (source) =>
      source.id.toLowerCase() === raw ||
      source.title.toLowerCase() === raw ||
      source.uri.toLowerCase() === raw ||
      source.uri.toLowerCase() === normalized ||
      path.basename(source.uri).toLowerCase() === raw,
  );
}

function searchSpecSections(
  store: SwarmStore,
  query: string,
  options: { domain?: string; tag?: string; source?: string; limit: number },
): Array<{
  source: ReturnType<SwarmStore["listSources"]>[number];
  section: ReturnType<typeof sourceSections>[number];
  score: number;
  snippet: string;
}> {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
  if (terms.length === 0) return [];
  return store
    .listSources()
    .filter((source) => !options.domain || sourceDomain(source).toLowerCase() === options.domain.toLowerCase())
    .filter((source) => !options.tag || sourceTags(source).map((tag) => tag.toLowerCase()).includes(options.tag.toLowerCase()))
    .filter((source) => !options.source || sourceMatchesSelector(source, options.source))
    .flatMap((source) => {
      const text = readSourceText(source);
      const sections = sourceSections(source).length > 0 ? sourceSections(source) : extractMarkdownSections(text, source.id);
      return sections
        .map((section) => {
          const haystack = [
            source.title,
            sourceDomain(source),
            ...sourceTags(source),
            section.title,
            section.snippet,
            ...section.refs,
          ]
            .join(" ")
            .toLowerCase();
          const score = terms.reduce((total, term) => total + countOccurrences(haystack, term), 0);
          return {
            source,
            section,
            score,
            snippet: highlightSnippet(section.snippet || section.title, terms),
          };
        })
        .filter((match) => match.score > 0);
    })
    .sort((a, b) => b.score - a.score || sourcePriority(a.source) - sourcePriority(b.source))
    .slice(0, options.limit);
}

function sourceMatchesSelector(source: ReturnType<SwarmStore["listSources"]>[number], selector: string): boolean {
  const raw = selector.toLowerCase();
  const normalized = path.resolve(selector).toLowerCase();
  return (
    source.id.toLowerCase() === raw ||
    source.title.toLowerCase() === raw ||
    source.uri.toLowerCase() === raw ||
    source.uri.toLowerCase() === normalized ||
    path.basename(source.uri).toLowerCase() === raw
  );
}

function countOccurrences(value: string, term: string): number {
  if (!term) return 0;
  let count = 0;
  let index = value.indexOf(term);
  while (index !== -1) {
    count += 1;
    index = value.indexOf(term, index + term.length);
  }
  return count;
}

function highlightSnippet(value: string, terms: string): string;
function highlightSnippet(value: string, terms: string[]): string;
function highlightSnippet(value: string, terms: string | string[]): string {
  const termList = Array.isArray(terms) ? terms : [terms];
  const lower = value.toLowerCase();
  const firstIndex = termList
    .map((term) => lower.indexOf(term.toLowerCase()))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  if (firstIndex === undefined) return value.slice(0, 220);
  const start = Math.max(0, firstIndex - 80);
  return `${start > 0 ? "..." : ""}${value.slice(start, start + 220)}${start + 220 < value.length ? "..." : ""}`;
}

function parseGraphFormat(value: string): "json" | "dot" {
  if (value !== "json" && value !== "dot") {
    throw new Error(`Invalid graph format: ${value}. Expected json or dot.`);
  }
  return value;
}

function parseWorkerDriver(value: string): string {
  const valid = new Set(["fixture", ...workerDriverIds()]);
  if (!valid.has(value)) {
    throw new Error(`Invalid worker driver: ${value}. Expected one of: ${[...valid].sort().join(", ")}.`);
  }
  return value;
}

function parseRunMode(value: string): RunMode {
  const allowed: RunMode[] = ["unspecified", "fixture", "scripted-codex", "live-agent-smoke"];
  if (!allowed.includes(value as RunMode)) {
    throw new Error(`Invalid run mode: ${value}. Expected ${allowed.join(", ")}.`);
  }
  return value as RunMode;
}

function currentRunMode(store: SwarmStore): RunMode {
  const value = store.getMeta(RUN_MODE_META_KEY);
  return value ? parseRunMode(value) : DEFAULT_RUN_MODE;
}

type SourceMutationFinding = {
  sourceId?: string;
  title?: string;
  uri: string;
  expectedHash?: string;
  currentHash?: string;
  mutated: boolean;
  reason?: string;
};

function runFixtureReview(input: {
  slice: SliceRecord;
  evidence: ReturnType<SwarmStore["listEvidence"]>;
  sourceMutations: SourceMutationFinding[];
}): ReviewResult {
  const evidenceIds = input.evidence
    .filter((item) => item.kind === "worker_result" || item.kind === "command")
    .map((item) => item.id);
  const sourceMutationDetected = input.sourceMutations.some((item) => item.mutated);
  return {
    status: sourceMutationDetected ? "human_required" : "accepted",
    summary: sourceMutationDetected
      ? "Fixture reviewer detected immutable source mutation."
      : "Fixture reviewer accepted the slice against recorded worker and command evidence.",
    frAcFindings: input.slice.frAcRefs.map((ref) => ({
      ref,
      status: sourceMutationDetected ? "uncertain" : "passed",
      evidence: evidenceIds,
      finding: sourceMutationDetected
        ? "Immutable source mutation prevents trustworthy review."
        : "Recorded evidence covers this in-scope FR/AC ref.",
    })),
    testAssessment: "Fixture reviewer used existing harness evidence for deterministic assessment.",
    sourceMutationDetected,
    stubOrHardcodeRisk: "none",
    requiredFixes: sourceMutationDetected ? ["Restore immutable source spec files before continuing."] : [],
    escalations: sourceMutationDetected
      ? [{ level: "human_required", message: "Immutable source spec mutation detected during review." }]
      : [],
    recommendation: sourceMutationDetected ? "Stop affected scope and restore source specs." : "Proceed to deterministic verification.",
  };
}

function buildReviewPrompt(input: {
  slice: SliceRecord;
  targetPath: string;
  laneName?: string;
  evidence: ReturnType<SwarmStore["listEvidence"]>;
  sourceMutations: SourceMutationFinding[];
}): string {
  const sourceRefs = input.slice.sourceRefs
    .map((source) => `- ${source.title ?? source.uri}: ${source.uri}${source.hash ? ` hash:${source.hash}` : ""}`)
    .join("\n");
  const evidenceLines =
    input.evidence.length > 0
      ? input.evidence.map((item) => `- ${item.id} ${item.kind}: ${item.summary}${item.ref ? ` (${item.ref})` : ""}`).join("\n")
      : "- none recorded";
  const latestWorker = input.evidence.filter((item) => item.kind === "worker_result" && item.ref).at(-1);
  const latestCommand = input.evidence.filter((item) => item.kind === "command").at(-1);
  return `You are an independent reviewer inside the Agent Swarm MVP harness.

You are reviewing implementation work for a slice. You must not edit code, state, or source specs.
Use read-only inspection. Judge whether the work genuinely satisfies the immutable FR/AC refs.

Target workspace:
${input.targetPath}

Lane:
${input.laneName ?? input.slice.laneId}

Slice:
${input.slice.id} - ${input.slice.title}

Delivery question:
${input.slice.deliveryQuestion}

Work package:
- type: ${input.slice.workPackageType}
- minimum meaningful outcome: ${input.slice.minimumMeaningfulOutcome}
${input.slice.acSizedExceptionReason ? `- AC-sized exception: ${input.slice.acSizedExceptionReason}` : ""}

Immutable source refs:
${sourceRefs}

FR/AC scope:
${input.slice.frAcRefs.map((ref) => `- ${ref}`).join("\n")}

Scope:
${input.slice.scope.map((item) => `- ${item}`).join("\n")}

Out of scope:
${input.slice.outOfScope.map((item) => `- ${item}`).join("\n")}

Expected evidence:
${input.slice.expectedEvidence.map((item) => `- ${item}`).join("\n")}

Verification requirements:
${input.slice.verificationRequirements.map((item) => `- ${item}`).join("\n")}

Recorded harness evidence:
${evidenceLines}

Latest worker result snippet:
${latestWorker?.ref ? readArtifactSnippet(latestWorker.ref) : "No worker result artifact recorded."}

Latest command evidence:
${latestCommand ? JSON.stringify(latestCommand.payload, null, 2).slice(0, 4000) : "No command evidence recorded yet."}

Source hash status:
${JSON.stringify(input.sourceMutations, null, 2)}

Review rules:
- Do not modify files or specs.
- Do not reinterpret or rewrite the source spec.
- Treat missing per-FR/AC evidence as a finding.
- Treat stubs, hardcoded shortcuts, hollow tests, or unproven runtime paths as material risks.
- If source spec mutation is detected, set sourceMutationDetected true and status human_required.
- If the work is close but needs code/test repair, use repair_required.
- If review cannot safely proceed due to missing evidence or runtime blockers, use blocked.
- If spec meaning is ambiguous, use human_required.
- Return only the required structured JSON result.
`;
}

function readArtifactSnippet(filePath: string, maxLength = 4000): string {
  if (!fs.existsSync(filePath)) return `Artifact missing: ${filePath}`;
  const content = fs.readFileSync(filePath, "utf8").trim();
  if (content.length <= maxLength) return content;
  return `${content.slice(0, maxLength)}\n... truncated ...`;
}

function inspectSourceMutations(slice: SliceRecord): SourceMutationFinding[] {
  return slice.sourceRefs.map((source) => {
    if (!source.hash) {
      return {
        sourceId: undefined,
        title: source.title,
        uri: source.uri,
        mutated: false,
        reason: "No registered source hash was available.",
      };
    }
    if (!fs.existsSync(source.uri)) {
      return {
        sourceId: undefined,
        title: source.title,
        uri: source.uri,
        expectedHash: source.hash,
        mutated: true,
        reason: "Source file is missing.",
      };
    }
    const currentHash = createHash("sha256").update(fs.readFileSync(source.uri)).digest("hex");
    return {
      sourceId: undefined,
      title: source.title,
      uri: source.uri,
      expectedHash: source.hash,
      currentHash,
      mutated: currentHash !== source.hash,
      reason: currentHash === source.hash ? undefined : "Source hash differs from registered immutable hash.",
    };
  });
}

function readReviewResultFile(filePath: string): { ok: true; result: ReviewResult } | { ok: false; reason: string } {
  if (!fs.existsSync(filePath)) return { ok: false, reason: `review_result file missing: ${filePath}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      reason: `review_result JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const result = reviewResultSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      reason: `review_result schema failed: ${result.error.message}`,
    };
  }
  return { ok: true, result: result.data };
}

function applyReviewOutcome(input: {
  store: SwarmStore;
  slice: SliceRecord;
  actor: string;
  result: ReviewResult;
  reviewEvidenceId: string;
  sourceMutationsAfter: SourceMutationFinding[];
}): void {
  const sourceMutationDetected = input.result.sourceMutationDetected || input.sourceMutationsAfter.some((item) => item.mutated);
  const effectiveStatus = sourceMutationDetected ? "human_required" : input.result.status;

  for (const escalation of input.result.escalations) {
    insertReviewEscalation(input.store, input.slice, input.actor, escalation.level, escalation.message, input.result.summary);
  }
  if (sourceMutationDetected) {
    insertReviewEscalation(
      input.store,
      input.slice,
      input.actor,
      "critical",
      "Immutable source spec mutation detected during review.",
      "Source hashes did not match registered immutable refs.",
    );
  }

  if (effectiveStatus === "accepted") {
    if (input.slice.status !== "accepted") input.store.updateSliceStatus(input.slice.id, "ready_for_review");
    input.store.upsertHeartbeat({
      id: `heartbeat:${input.actor}`,
      actor: input.actor,
      state: "idle",
      detail: "Independent review accepted",
      entityType: "slice",
      entityId: input.slice.id,
    });
    return;
  }

  const nextStatus: SliceRecord["status"] = effectiveStatus === "repair_required" ? "repairing" : "blocked";
  input.store.updateSliceStatus(input.slice.id, nextStatus);
  input.store.updateDependenciesFor("slice", input.slice.id, "blocked");
  const hasBlockingEscalation = input.result.escalations.some((item) => ["blocker", "human_required", "critical"].includes(item.level));
  if (!hasBlockingEscalation && !sourceMutationDetected) {
    insertReviewEscalation(
      input.store,
      input.slice,
      input.actor,
      effectiveStatus === "human_required" ? "human_required" : "blocker",
      `Independent review status is ${effectiveStatus}.`,
      input.result.recommendation,
    );
  }
  input.store.upsertHeartbeat({
    id: `heartbeat:${input.actor}`,
    actor: input.actor,
    state: "blocked",
    detail: `Independent review ${effectiveStatus}: ${input.result.recommendation}`,
    entityType: "slice",
    entityId: input.slice.id,
  });
  input.store.addEvent(
    createEvent({
      actor: input.actor,
      type: "review.blocked_acceptance",
      entityType: "slice",
      entityId: input.slice.id,
      payload: {
        reviewEvidenceId: input.reviewEvidenceId,
        reviewStatus: effectiveStatus,
        requiredFixes: input.result.requiredFixes,
        recommendation: input.result.recommendation,
      },
    }),
  );
}

function insertReviewEscalation(
  store: SwarmStore,
  slice: SliceRecord,
  actor: string,
  level: "warning" | "blocker" | "human_required" | "critical",
  message: string,
  reason?: string,
): void {
  const now = new Date().toISOString();
  const escalation = {
    id: makeId("escalation"),
    level,
    status: "active" as const,
    entityType: "slice" as const,
    entityId: slice.id,
    message,
    reason,
    createdBy: actor,
    createdAt: now,
    updatedAt: now,
  };
  store.insertEscalation(escalation);
  store.addEvent(
    createEvent({
      actor,
      type: "review.escalation_raised",
      entityType: "slice",
      entityId: slice.id,
      payload: {
        escalationId: escalation.id,
        level,
        message,
        reason,
      },
    }),
  );
}

function latestReviewResult(evidence: Array<ReturnType<SwarmStore["listEvidence"]>[number]>): ReviewResult | undefined {
  const reviewEvidence = evidence
    .filter((item) => item.kind === "review_result" && item.payload.reviewResult)
    .at(-1);
  if (!reviewEvidence) return undefined;
  const parsed = reviewResultSchema.safeParse(reviewEvidence.payload.reviewResult);
  return parsed.success ? parsed.data : undefined;
}

function readLatestReviewGate(
  store: SwarmStore,
  slice: SliceRecord,
  verifier: string,
): { passed: boolean; reason: string; status?: ReviewResult["status"]; evidenceId?: string } {
  const reviewEvidence = store
    .listEvidence(slice.id)
    .filter((item) => item.kind === "review_result" && item.payload.reviewResult)
    .at(-1);
  if (!reviewEvidence) return { passed: true, reason: "no review result recorded" };
  const parsed = reviewResultSchema.safeParse(reviewEvidence.payload.reviewResult);
  if (!parsed.success) {
    return {
      passed: false,
      reason: `review_result schema failed: ${parsed.error.message}`,
      status: "blocked",
      evidenceId: reviewEvidence.id,
    };
  }
  const sourceMutationsAfter = Array.isArray(reviewEvidence.payload.sourceMutationsAfter)
    ? (reviewEvidence.payload.sourceMutationsAfter as SourceMutationFinding[])
    : [];
  if (parsed.data.sourceMutationDetected || sourceMutationsAfter.some((item) => item.mutated)) {
    return {
      passed: false,
      reason: "latest review detected immutable source mutation",
      status: "human_required",
      evidenceId: reviewEvidence.id,
    };
  }
  if (parsed.data.status !== "accepted") {
    return {
      passed: false,
      reason: `latest review status is ${parsed.data.status}`,
      status: parsed.data.status,
      evidenceId: reviewEvidence.id,
    };
  }
  const findingsByRef = new Map(parsed.data.frAcFindings.map((item) => [item.ref, item]));
  const nonPassingRefs = slice.frAcRefs.filter((ref) => findingsByRef.get(ref)?.status !== "passed");
  if (nonPassingRefs.length > 0) {
    return {
      passed: false,
      reason: `latest review has non-passing FR/AC findings from ${verifier}: ${nonPassingRefs.join(", ")}`,
      status: "blocked",
      evidenceId: reviewEvidence.id,
    };
  }
  if (parsed.data.stubOrHardcodeRisk === "high") {
    return {
      passed: false,
      reason: "latest review reported high stub/hardcode risk",
      status: "blocked",
      evidenceId: reviewEvidence.id,
    };
  }
  return {
    passed: true,
    reason: "latest review accepted",
    status: "accepted",
    evidenceId: reviewEvidence.id,
  };
}

function validateSliceDispatchContract(slice: SliceRecord): void {
  const missing: string[] = [];
  if (slice.frAcRefs.length === 0) missing.push("frAcRefs");
  if (!slice.deliveryQuestion.trim()) missing.push("deliveryQuestion");
  if (slice.expectedEvidence.length === 0) missing.push("expectedEvidence");
  if (missing.length > 0) {
    throw new Error(`Slice ${slice.id} is missing required planning fields: ${missing.join(", ")}`);
  }
  const proofLike = slice.workPackageType === "proof_pack" || slice.workPackageType === "diagnostic";
  if (proofLike && slice.frAcRefs.length === 1 && !slice.acSizedExceptionReason?.trim()) {
    throw new Error(
      `Slice ${slice.id} is AC-sized ${slice.workPackageType} work without an exception reason. Create a component/readiness pack or record acSizedExceptionReason.`,
    );
  }
  if (proofLike && slice.frAcRefs.length < 2 && slice.unblockTargets.length === 0 && !slice.acSizedExceptionReason?.trim()) {
    throw new Error(
      `Slice ${slice.id} does not declare a meaningful unblock/readiness target. Add unblockTargets or use a multi-AC readiness pack.`,
    );
  }
}

function readAndValidateWorkerResult(
  store: SwarmStore,
  slice: SliceRecord,
  verifier: string,
): { passed: boolean; reason: string; coveredRefs: string[]; frAcResults: FrAcVerificationResult[] } {
  const workerEvidence = store
    .listEvidence(slice.id)
    .filter((item) => item.kind === "worker_result" && item.ref)
    .at(-1);
  if (!workerEvidence?.ref) {
    return {
      passed: false,
      reason: "missing worker_result evidence",
      coveredRefs: [],
      frAcResults: missingEvidenceResults(slice, verifier, "No structured worker result was recorded."),
    };
  }
  if (!fs.existsSync(workerEvidence.ref)) {
    return {
      passed: false,
      reason: `worker_result file missing: ${workerEvidence.ref}`,
      coveredRefs: [],
      frAcResults: missingEvidenceResults(slice, verifier, `Worker result file was missing: ${workerEvidence.ref}`),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(workerEvidence.ref, "utf8"));
  } catch (error) {
    return {
      passed: false,
      reason: `worker_result JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
      coveredRefs: [],
      frAcResults: missingEvidenceResults(slice, verifier, "Worker result could not be parsed as JSON."),
    };
  }
  const result = workerResultSchema.safeParse(parsed);
  if (!result.success) {
    return {
      passed: false,
      reason: `worker_result schema failed: ${result.error.message}`,
      coveredRefs: [],
      frAcResults: missingEvidenceResults(slice, verifier, "Worker result did not match the required schema."),
    };
  }
  if (result.data.status !== "passed") {
    return {
      passed: false,
      reason: `worker_result status is ${result.data.status}`,
      coveredRefs: [],
      frAcResults: slice.frAcRefs.map((ref) => ({
        ref,
        status: result.data.frAcCoverage.some((item) => item.ref === ref) ? "failed" : "missing_evidence",
        evidenceIds: [workerEvidence.id],
        proof: `Worker result status is ${result.data.status}.`,
        verifiedBy: verifier,
      })),
    };
  }
  const coveredRefs = result.data.frAcCoverage
    .filter((item) => item.status === "covered")
    .map((item) => item.ref);
  const missingRefs = slice.frAcRefs.filter((ref) => !coveredRefs.includes(ref));
  const workerResults: FrAcVerificationResult[] = slice.frAcRefs.map((ref) => {
    const coverage = result.data.frAcCoverage.find((item) => item.ref === ref);
    if (!coverage) {
      return {
        ref,
        status: "missing_evidence",
        evidenceIds: [workerEvidence.id],
        proof: "Worker result did not include this FR/AC ref.",
        verifiedBy: verifier,
      };
    }
    if (coverage.status !== "covered") {
      return {
        ref,
        status: coverage.status === "blocked" ? "failed" : "missing_evidence",
        evidenceIds: [workerEvidence.id],
        proof: coverage.evidence,
        verifiedBy: verifier,
      };
    }
    return {
      ref,
      status: "passed",
      evidenceIds: [workerEvidence.id],
      proof: coverage.evidence,
      verifiedBy: verifier,
    };
  });
  if (missingRefs.length > 0) {
    return {
      passed: false,
      reason: `worker_result missing covered refs: ${missingRefs.join(", ")}`,
      coveredRefs,
      frAcResults: workerResults,
    };
  }
  return { passed: true, reason: "worker_result covers every leased ref", coveredRefs, frAcResults: workerResults };
}

function missingEvidenceResults(slice: SliceRecord, verifier: string, proof: string): FrAcVerificationResult[] {
  return slice.frAcRefs.map((ref) => ({
    ref,
    status: "missing_evidence",
    evidenceIds: [],
    proof,
    verifiedBy: verifier,
  }));
}

function buildFrAcResults(input: {
  slice: SliceRecord;
  verifier: string;
  commandPassed: boolean;
  workerGate: ReturnType<typeof readAndValidateWorkerResult>;
  verificationEvidenceId: string;
}): FrAcVerificationResult[] {
  return input.slice.frAcRefs.map((ref) => {
    const workerResult = input.workerGate.frAcResults.find((item) => item.ref === ref);
    if (!workerResult) {
      return {
        ref,
        status: "missing_evidence",
        evidenceIds: [input.verificationEvidenceId],
        proof: "No worker coverage result was available for this ref.",
        verifiedBy: input.verifier,
      };
    }
    if (workerResult.status !== "passed") {
      return {
        ...workerResult,
        evidenceIds: [...workerResult.evidenceIds, input.verificationEvidenceId],
        verifiedBy: input.verifier,
      };
    }
    if (!input.commandPassed) {
      return {
        ref,
        status: "failed",
        evidenceIds: [...workerResult.evidenceIds, input.verificationEvidenceId],
        proof: "Worker coverage existed, but the configured verification command failed.",
        verifiedBy: input.verifier,
      };
    }
    return {
      ...workerResult,
      evidenceIds: [...workerResult.evidenceIds, input.verificationEvidenceId],
      verifiedBy: input.verifier,
    };
  });
}

function detectAndRecordLowSignalWork(store: SwarmStore, acceptedSlice: SliceRecord): void {
  const threshold = 2;
  const laneSlices = store
    .listSlices()
    .filter((slice) => slice.laneId === acceptedSlice.laneId && slice.status === "accepted")
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const recentAccepted = laneSlices.slice(-threshold);
  if (recentAccepted.length < threshold) return;

  const lowSignalSlices = recentAccepted.filter((slice) => isLowSignalAcceptedSlice(store, slice));
  if (lowSignalSlices.length < threshold) return;

  const activeDuplicate = store
    .listEscalations("active")
    .some(
      (escalation) =>
        escalation.entityType === "lane" &&
        escalation.entityId === acceptedSlice.laneId &&
        escalation.message.includes("Low-signal slice cadence detected"),
    );
  if (activeDuplicate) return;

  const now = new Date().toISOString();
  const sliceIds = lowSignalSlices.map((slice) => slice.id);
  const message =
    "Low-signal slice cadence detected: recent accepted slices did not declare unblock targets or satisfy meaningful dependencies.";
  const reason =
    "Accepted slices should answer a delivery question. These slices passed mechanically, but the harness cannot see what downstream dependency, blocker, or readiness target they moved.";
  const escalation = {
    id: makeId("escalation"),
    level: "warning" as const,
    status: "active" as const,
    entityType: "lane" as const,
    entityId: acceptedSlice.laneId,
    message,
    reason,
    createdBy: "planning-agent",
    createdAt: now,
    updatedAt: now,
  };
  store.insertEscalation(escalation);
  store.addEvent(
    createEvent({
      actor: "planning-agent",
      type: "planner.low_signal_work",
      entityType: "lane",
      entityId: acceptedSlice.laneId,
      payload: {
        escalationId: escalation.id,
        level: escalation.level,
        sliceIds,
        threshold,
        reason,
        suggestedAction:
          "Create a readiness pack or revise the lane delivery question so the next slice has an explicit unblock/readiness target.",
      },
    }),
  );
  refreshCheckpoint({
    store,
    role: "planner",
    entityType: "lane",
    entityId: acceptedSlice.laneId,
    actor: "planning-agent",
    reason: "Low-signal work warning raised.",
  });
}

function isLowSignalAcceptedSlice(store: SwarmStore, slice: SliceRecord): boolean {
  if (slice.unblockTargets.length > 0) return false;
  const meaningfulSatisfiedDependencies = store
    .listDependencies()
    .filter((dependency) => dependency.fromType === "slice" && dependency.fromId === slice.id)
    .filter((dependency) => currentDependencyStatus(store, dependency) === "satisfied")
    .filter((dependency) => dependency.target !== "target test command");
  if (meaningfulSatisfiedDependencies.length > 0) return false;
  return true;
}

function buildTimeline(store: SwarmStore, entityId: string): {
  entityId: string;
  entityType?: string;
  items: Array<{
    timestamp: string;
    kind: string;
    label: string;
    actor?: string;
    detail?: string;
    payload?: Record<string, unknown>;
  }>;
} {
  const slices = store.listSlices();
  const lanes = store.listLanes();
  const leases = store.listLeases();
  const evidence = store.listEvidence();
  const heartbeats = store.listHeartbeats();
  const escalations = store.listEscalations();
  const dependencies = store.listDependencies();
  const relatedSliceIds = new Set<string>();
  const relatedLaneIds = new Set<string>();
  const relatedRefs = new Set<string>();

  const directSlice = slices.find((slice) => slice.id === entityId);
  const directLane = lanes.find((lane) => lane.id === entityId);
  if (directSlice) {
    relatedSliceIds.add(directSlice.id);
    relatedLaneIds.add(directSlice.laneId);
    for (const ref of directSlice.frAcRefs) relatedRefs.add(ref);
  } else if (directLane) {
    relatedLaneIds.add(directLane.id);
    for (const slice of slices.filter((item) => item.laneId === directLane.id)) {
      relatedSliceIds.add(slice.id);
      for (const ref of slice.frAcRefs) relatedRefs.add(ref);
    }
  } else {
    for (const lease of leases.filter((item) => item.frAcRef === entityId)) {
      relatedSliceIds.add(lease.sliceId);
      relatedLaneIds.add(lease.laneId);
      relatedRefs.add(lease.frAcRef);
    }
  }

  const items = [
    ...slices
      .filter((slice) => relatedSliceIds.has(slice.id))
      .flatMap((slice) => [
        {
          timestamp: slice.createdAt,
          kind: "slice",
          label: `${slice.id} created`,
          detail: `${slice.title} [${slice.status}]`,
        },
        {
          timestamp: slice.updatedAt,
          kind: "slice",
          label: `${slice.id} updated`,
          detail: `status ${slice.status}`,
        },
      ]),
    ...lanes
      .filter((lane) => relatedLaneIds.has(lane.id))
      .map((lane) => ({
        timestamp: lane.createdAt,
        kind: "lane",
        label: `${lane.id} ${lane.name}`,
        detail: `${lane.state}; ${lane.purpose}`,
      })),
    ...leases
      .filter((lease) => relatedSliceIds.has(lease.sliceId) || relatedRefs.has(lease.frAcRef))
      .map((lease) => ({
        timestamp: lease.updatedAt,
        kind: "lease",
        label: lease.frAcRef,
        detail: `${lease.status} via ${lease.sliceId}`,
      })),
    ...dependencies
      .filter((dependency) => relatedSliceIds.has(dependency.fromId) || relatedLaneIds.has(dependency.fromId) || dependency.target === entityId)
      .map((dependency) => ({
        timestamp: dependency.updatedAt,
        kind: "dependency",
        label: dependency.target,
        detail: `${dependency.status}; ${dependency.reason}`,
      })),
    ...evidence
      .filter((item) => relatedSliceIds.has(item.sliceId))
      .map((item) => ({
        timestamp: item.createdAt,
        kind: "evidence",
        label: `${item.kind} for ${item.sliceId}`,
        detail: item.summary,
        payload: item.payload,
      })),
    ...heartbeats
      .filter((heartbeat) => heartbeat.entityId && (heartbeat.entityId === entityId || relatedSliceIds.has(heartbeat.entityId) || relatedLaneIds.has(heartbeat.entityId)))
      .map((heartbeat) => ({
        timestamp: heartbeat.timestamp,
        kind: "heartbeat",
        actor: heartbeat.actor,
        label: heartbeat.state,
        detail: heartbeat.detail,
      })),
    ...escalations
      .filter((escalation) => escalation.entityId === entityId || relatedSliceIds.has(escalation.entityId) || relatedLaneIds.has(escalation.entityId))
      .map((escalation) => ({
        timestamp: escalation.updatedAt,
        kind: "escalation",
        actor: escalation.createdBy,
        label: `${escalation.level} ${escalation.status}`,
        detail: escalation.message,
      })),
    ...store
      .listEvents()
      .filter(
        (event) =>
          event.entityId === entityId ||
          relatedSliceIds.has(event.entityId) ||
          relatedLaneIds.has(event.entityId) ||
          relatedSliceIds.has(String(event.payload.sliceId ?? "")),
      )
      .map((event) => ({
        timestamp: event.timestamp,
        kind: "event",
        actor: event.actor,
        label: `${event.type} ${event.entityType}:${event.entityId}`,
        payload: event.payload,
      })),
  ].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return {
    entityId,
    entityType: directSlice ? "slice" : directLane ? "lane" : relatedRefs.has(entityId) ? "fr_ac_ref" : undefined,
    items,
  };
}

function buildGraph(store: SwarmStore): {
  nodes: Array<{ id: string; type: string; label: string; status?: string }>;
  edges: Array<{ from: string; to: string; type: string; label?: string; status?: string }>;
} {
  const targets = store.listTargets();
  const sources = store.listSources();
  const lanes = store.listLanes();
  const slices = store.listSlices();
  const leases = store.listLeases();
  const dependencies = store.listDependencies();
  const evidence = store.listEvidence();
  const heartbeats = store.listHeartbeats();
  const events = store.listEvents();
  const nodes = new Map<string, { id: string; type: string; label: string; status?: string }>();
  const edges: Array<{ from: string; to: string; type: string; label?: string; status?: string }> = [];

  for (const target of targets) nodes.set(target.id, { id: target.id, type: "target", label: target.name });
  for (const source of sources) {
    const domainId = `domain:${sourceDomain(source)}`;
    nodes.set(domainId, { id: domainId, type: "domain", label: sourceDomain(source) });
    nodes.set(source.id, { id: source.id, type: "source", label: source.title });
    edges.push({ from: domainId, to: source.id, type: "domain_source", label: "contains" });
    for (const section of sourceSections(source)) {
      nodes.set(section.id, { id: section.id, type: "source_section", label: section.title });
      edges.push({ from: source.id, to: section.id, type: "source_section", label: `lines ${section.startLine}-${section.endLine}` });
      for (const ref of section.refs) {
        setFrAcNode(nodes, store, ref);
        edges.push({ from: section.id, to: ref, type: "section_ref", label: "defines" });
      }
    }
    for (const ref of sourceFrAcRefs(source)) {
      setFrAcNode(nodes, store, ref);
      edges.push({ from: source.id, to: ref, type: "source_ref", label: "indexes" });
    }
  }
  for (const lane of lanes) {
    nodes.set(lane.id, { id: lane.id, type: "lane", label: lane.name, status: lane.state });
    edges.push({ from: lane.targetId, to: lane.id, type: "target_lane", label: "hosts" });
  }
  for (const slice of slices) {
    nodes.set(slice.id, { id: slice.id, type: "slice", label: slice.title, status: slice.status });
    edges.push({ from: slice.laneId, to: slice.id, type: "lane_slice", label: "contains" });
    for (const sourceRef of slice.sourceRefs) {
      const source = sources.find((item) => item.uri === sourceRef.uri);
      if (source) edges.push({ from: source.id, to: slice.id, type: "source_slice", label: "served" });
    }
    for (const ref of slice.frAcRefs) {
      setFrAcNode(nodes, store, ref);
      edges.push({ from: ref, to: slice.id, type: "ref_slice", label: "leased" });
    }
  }
  for (const lease of leases) {
    setFrAcNode(nodes, store, lease.frAcRef);
    edges.push({ from: lease.sliceId, to: lease.frAcRef, type: "slice_ref_status", label: lease.status, status: lease.status });
  }
  for (const dependency of dependencies) {
    const status = currentDependencyStatus(store, dependency);
    if (!nodes.has(dependency.target)) {
      nodes.set(dependency.target, { id: dependency.target, type: "dependency_target", label: dependency.target, status });
    }
    edges.push({ from: dependency.target, to: dependency.fromId, type: "dependency", label: dependency.reason, status });
  }
  for (const item of evidence) {
    nodes.set(item.id, { id: item.id, type: "evidence", label: `${item.kind}: ${item.summary}` });
    edges.push({ from: item.sliceId, to: item.id, type: "evidence", label: item.kind });
  }
  for (const heartbeat of heartbeats) {
    nodes.set(heartbeat.id, { id: heartbeat.id, type: "heartbeat", label: `${heartbeat.actor}: ${heartbeat.state}`, status: heartbeat.state });
    if (heartbeat.entityId) edges.push({ from: heartbeat.id, to: heartbeat.entityId, type: "heartbeat_for", label: heartbeat.actor });
  }
  for (const event of events.filter((item) => item.type.includes("worker") || item.type.includes("verification") || item.type.includes("review") || item.type.includes("overseer"))) {
    const actorNode = `actor:${event.actor}`;
    nodes.set(actorNode, { id: actorNode, type: "actor", label: event.actor });
    if (!nodes.has(event.entityId)) nodes.set(event.entityId, { id: event.entityId, type: event.entityType, label: event.entityId });
    edges.push({ from: actorNode, to: event.entityId, type: "actor_event", label: event.type });
  }

  return { nodes: [...nodes.values()], edges };
}

function setFrAcNode(
  nodes: Map<string, { id: string; type: string; label: string; status?: string }>,
  store: SwarmStore,
  ref: string,
): void {
  nodes.set(ref, { id: ref, type: "fr_ac", label: ref, status: store.latestLeaseFor(ref)?.status });
}

function currentDependencyStatus(
  store: SwarmStore,
  dependency: ReturnType<SwarmStore["listDependencies"]>[number],
): "pending" | "satisfied" | "blocked" {
  const targetLease = store.latestLeaseFor(dependency.target);
  if (targetLease?.status === "completed") return "satisfied";
  return dependency.status;
}

function renderDot(graph: ReturnType<typeof buildGraph>): string {
  const lines = ["digraph swarm {", "  rankdir=LR;"];
  for (const node of graph.nodes) {
    lines.push(`  ${dotId(node.id)} [label="${escapeDot(`${node.label}\\n${node.type}${node.status ? `:${node.status}` : ""}`)}"];`);
  }
  for (const edge of graph.edges) {
    const label = edge.label ?? edge.type;
    lines.push(`  ${dotId(edge.from)} -> ${dotId(edge.to)} [label="${escapeDot(label)}"];`);
  }
  lines.push("}");
  return lines.join("\n");
}

function dotId(value: string): string {
  return `"${escapeDot(value)}"`;
}

function escapeDot(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function scenarioEntityId(scenario: string): string {
  return `scenario:${scenario}`;
}

function sanitizeArtifactSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "artifact";
}

function loadScenarioManifest(workspace: string, scenario: string): ScenarioManifestLoad {
  const manifestPath = path.join(workspace, `${scenario}.json`);
  if (!fs.existsSync(manifestPath)) {
    return {
      path: manifestPath,
      exists: false,
      data: {
        scenarioId: scenario,
        missing: true,
        note: "Scenario manifest was not found; overseer should report this as a blocker or recommend reset.",
      },
    };
  }

  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      path: manifestPath,
      exists: true,
      data: {
        scenarioId: scenario,
        invalid: true,
        rawType: typeof parsed,
      },
    };
  }
  return { path: manifestPath, exists: true, data: parsed as Record<string, unknown> };
}

function buildOverseerPrompt(input: {
  workspace: string;
  scenario: string;
  manifest: ScenarioManifestLoad;
  snapshot: ReturnType<typeof buildObservabilitySnapshot>;
  execute: boolean;
}): string {
  return `You are the visible overseer agent for the Agent Swarm live smoke harness.

Scenario:
${input.scenario}

Workspace:
${input.workspace}

Your current execution mode:
${input.execute ? "- Phase 5B bounded execution is enabled after your decision is recorded." : "- Planning only; the harness will record your decision but will not execute recommended commands."}
- You may dispatch worker and reviewer child agents only through harness commands when execution is enabled.
- Do not dispatch verifier agents yet.
- Do not edit target code.
- Do not mutate source specs.
- Recommend exact harness commands that move harness state forward.
${input.execute ? "- The harness may execute allowlisted state commands plus bounded child dispatch: run/review with an existing slice id, explicit --actor, and --driver codex. Deterministic verify remains blocked until a later acceptance-gate phase." : "- A human or later runner may execute recommended commands next."}

Planning priorities:
- Use immutable source specs and FR/AC refs as the source of truth.
- Backend capabilities must be accepted before real frontend/dashboard slices are served against them.
- Prefer meaningful component/capability slices over proof-only or AC-churn slices.
- If a required manifest, source, target, or state boundary is missing, report a blocker with scope and next action.
- Keep commands inside the harness contract; never recommend direct SQLite edits or hidden state mutation.

Allowed command contract:
- node "${process.argv[1]}" observe --events 120
- node "${process.argv[1]}" sources list
- node "${process.argv[1]}" domains list
- node "${process.argv[1]}" domains inspect <domain>
- node "${process.argv[1]}" slices pull --target <target> --source <source> --batch-size <n> [lane options]
- node "${process.argv[1]}" run <slice-id> --actor <actor> --driver codex
- node "${process.argv[1]}" review <slice-id> --actor <actor> --driver codex
- node "${process.argv[1]}" verify <slice-id> --actor <actor> --force (recommend only; blocked from execution in Phase 5B)
- node "${process.argv[1]}" report <slice-id>
- node "${process.argv[1]}" checkpoint create --role <role> --entity <type:id> --summary <summary>
- node "${process.argv[1]}" escalations create --level <level> --entity <type:id> --message <message>

Scenario manifest:
${jsonForPrompt(input.manifest)}

Current harness snapshot:
${jsonForPrompt(input.snapshot)}

Return only the required JSON object. Your decision must include:
- currentPriority
- recommendedCommands with purpose and expectedStateChange
- lanePlan
- blockers, if any
- stopCondition
- nextAction
`;
}

function buildOverseerLaunchPrompt(promptPath: string, scenario: string): string {
  return `You are the visible overseer agent for scenario ${scenario}. Read the full harness prompt from this file, follow it exactly, and return only the required JSON object: ${promptPath}`;
}

function runFixtureOverseerDecision(input: {
  scenario: string;
  snapshot: ReturnType<typeof buildObservabilitySnapshot>;
}): OverseerDecision {
  const activeSlices = input.snapshot.slices.filter((slice) => !["accepted", "closed"].includes(slice.status));
  const pendingBackend = activeSlices.find((slice) => slice.targetId === input.snapshot.targets.find((target) => target.name === "invoice-api")?.id);
  const cli = `node "${process.argv[1]}"`;
  const blockers = input.snapshot.activeEscalations.map((escalation) => ({
    level: escalation.level === "info" ? "warning" as const : escalation.level as OverseerDecision["blockers"][number]["level"],
    message: escalation.message,
    scope: `${escalation.entityType}:${escalation.entityId}`,
  }));

  const hasInvoiceBackendSource = input.snapshot.sources.some(
    (source) => sourceDomain(source).toLowerCase() === "invoice backend" || source.uri.toLowerCase().includes("invoice-api.md"),
  );
  if (!hasInvoiceBackendSource) {
    return {
      status: "blocked",
      summary: "Fixture overseer cannot plan because the invoice backend source is not registered.",
      scenario: input.scenario,
      currentPriority: "Reset or register the live smoke sources before dispatching agents.",
      recommendedCommands: [
        {
          command: "npm run demo:live-agent:reset",
          purpose: "Recreate the disposable live smoke workspace and register immutable specs.",
          expectedStateChange: "Harness state contains invoice-api, invoice-dashboard, and product sources.",
          requiresHuman: false,
        },
      ],
      lanePlan: [],
      blockers: [
        {
          level: "blocker",
          message: "Invoice backend source is missing from the source registry.",
          scope: `harness:${scenarioEntityId(input.scenario)}`,
        },
      ],
      stopCondition: "Stop until the scenario workspace has been reset or sources have been registered.",
      nextAction: "Reset the live smoke scenario, then run the overseer again.",
    };
  }

  if (pendingBackend) {
    const command =
      pendingBackend.status === "implemented" || pendingBackend.status === "ready_for_review"
        ? `${cli} review ${pendingBackend.id} --actor live-reviewer --driver codex`
        : `${cli} run ${pendingBackend.id} --actor live-backend-worker --driver codex`;
    return {
      status: "recommend_commands",
      summary: `Fixture overseer recommends continuing backend slice ${pendingBackend.id}.`,
      scenario: input.scenario,
      currentPriority: `Move ${pendingBackend.id} toward accepted backend capability before frontend work.`,
      recommendedCommands: [
        {
          command,
          purpose: pendingBackend.status === "implemented" || pendingBackend.status === "ready_for_review"
            ? "Run independent reviewer judgement before deterministic acceptance."
            : "Dispatch the backend worker against the current meaningful invoice slice.",
          expectedStateChange: "The backend slice gains worker or review evidence visible in observe and the UI.",
          requiresHuman: false,
        },
      ],
      lanePlan: [
        {
          laneName: "Backend Lane: Invoice Query Core",
          purpose: "Complete accepted backend invoice capabilities before dashboard slices are served.",
          nextAction: `Continue ${pendingBackend.id}`,
        },
      ],
      blockers,
      stopCondition: "Stop after the next bounded child-agent command is recorded or executed.",
      nextAction: "Run the recommended command through the harness, then observe state again.",
    };
  }

  return {
    status: "recommend_commands",
    summary: "Fixture overseer recommends pulling the first meaningful backend capability slice.",
    scenario: input.scenario,
    currentPriority: "Create a backend invoice capability slice before dashboard work.",
    recommendedCommands: [
      {
        command: `${cli} slices pull --target invoice-api --source invoice-api.md --new-lane --lane-name "Backend Lane: Invoice Query Core" --lane-purpose "Implement accepted invoice backend capabilities before dashboard slices" --lane-labels backend,invoice-api,live-smoke --orchestrator live-overseer --batch-size 3`,
        purpose: "Serve a real backend work package with immutable FR/AC refs.",
        expectedStateChange: "A backend lane and slice are created with active FR/AC leases.",
        requiresHuman: false,
      },
      {
        command: `${cli} observe --events 120`,
        purpose: "Confirm the created slice, lane, and leases before dispatch.",
        expectedStateChange: "Snapshot shows the backend slice and no hidden worker run yet.",
        requiresHuman: false,
      },
    ],
    lanePlan: [
      {
        laneName: "Backend Lane: Invoice Query Core",
        purpose: "Start with accepted backend capability because dashboard work depends on it.",
        nextAction: "Pull first backend slice, then dispatch a worker in Phase 5.",
      },
    ],
    blockers,
    stopCondition: "Stop after bounded planning-state commands are recorded or executed.",
    nextAction: "Execute the pull command, then run the overseer again to dispatch a worker.",
  };
}

function readOverseerDecisionFile(filePath: string): { ok: true; decision: OverseerDecision } | { ok: false; reason: string } {
  if (!fs.existsSync(filePath)) return { ok: false, reason: `overseer decision file missing: ${filePath}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      reason: `overseer decision JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const result = overseerDecisionSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      reason: `overseer decision schema failed: ${result.error.message}`,
    };
  }
  return { ok: true, decision: result.data };
}

function applyOverseerDecision(input: {
  store: SwarmStore;
  workspace: string;
  actor: string;
  scenario: string;
  entityId: string;
  runId: string;
  decision: OverseerDecision;
  resultPath: string;
  eventsPath: string;
  overseerEvents: ReturnType<typeof ingestWorkerJsonl>;
  artifactPath: string;
  execute: boolean;
  executeLimit: number;
}): OverseerCommandExecution[] {
  input.store.setMeta(`overseer:last:${input.scenario}`, input.resultPath);
  input.store.upsertHeartbeat({
    id: `heartbeat:${input.actor}`,
    actor: input.actor,
    state: input.decision.status === "blocked" || input.decision.status === "human_required" ? "blocked" : "idle",
    detail: input.decision.nextAction,
    entityType: "harness",
    entityId: input.entityId,
  });
  input.store.addEvent(
    createEvent({
      actor: input.actor,
      type: "overseer.decision_recorded",
      entityType: "harness",
      entityId: input.entityId,
      payload: {
        runId: input.runId,
        scenario: input.scenario,
        status: input.decision.status,
        summary: input.decision.summary,
        currentPriority: input.decision.currentPriority,
        recommendedCommands: input.decision.recommendedCommands,
        lanePlan: input.decision.lanePlan,
        blockers: input.decision.blockers,
        stopCondition: input.decision.stopCondition,
        nextAction: input.decision.nextAction,
        resultPath: input.resultPath,
        eventsPath: input.eventsPath,
        overseerEvents: input.overseerEvents,
      },
    }),
  );

  const blockers = [...input.decision.blockers];
  if ((input.decision.status === "blocked" || input.decision.status === "human_required") && blockers.length === 0) {
    blockers.push({
      level: input.decision.status === "human_required" ? "human_required" : "blocker",
      message: input.decision.summary,
      scope: `harness:${input.entityId}`,
    });
  }

  for (const blocker of blockers) {
    const now = new Date().toISOString();
    const escalation = {
      id: makeId("escalation"),
      level: blocker.level,
      status: "active" as const,
      entityType: "harness" as const,
      entityId: input.entityId,
      message: blocker.message,
      reason: blocker.scope,
      createdBy: input.actor,
      createdAt: now,
      updatedAt: now,
    };
    input.store.insertEscalation(escalation);
    input.store.addEvent(
      createEvent({
        actor: input.actor,
        type: "overseer.escalation_raised",
        entityType: "harness",
        entityId: input.entityId,
        payload: {
          escalationId: escalation.id,
          level: blocker.level,
          message: blocker.message,
          scope: blocker.scope,
        },
      }),
    );
  }

  const commandResults = input.execute
    ? executeOverseerRecommendedCommands({
        store: input.store,
        workspace: input.workspace,
        actor: input.actor,
        entityId: input.entityId,
        runId: input.runId,
        decision: input.decision,
        artifactPath: input.artifactPath,
        limit: input.executeLimit,
      })
    : [];

  if (input.execute) {
    input.store.addEvent(
      createEvent({
        actor: input.actor,
        type: "overseer.commands_completed",
        entityType: "harness",
        entityId: input.entityId,
        payload: {
          runId: input.runId,
          scenario: input.scenario,
          executed: commandResults.filter((item) => item.status === "executed").length,
          blocked: commandResults.filter((item) => item.status === "blocked").length,
          failed: commandResults.filter((item) => item.status === "failed").length,
          results: commandResults,
        },
      }),
    );
  }

  input.store.addEvent(
    createEvent({
      actor: input.actor,
      type: "overseer.completed",
      entityType: "harness",
      entityId: input.entityId,
      payload: {
        runId: input.runId,
        scenario: input.scenario,
        status: input.decision.status,
        nextAction: input.decision.nextAction,
        commandResults,
      },
    }),
  );
  return commandResults;
}

function executeOverseerRecommendedCommands(input: {
  store: SwarmStore;
  workspace: string;
  actor: string;
  entityId: string;
  runId: string;
  decision: OverseerDecision;
  artifactPath: string;
  limit: number;
}): OverseerCommandExecution[] {
  if (input.decision.status !== "recommend_commands") return [];
  const commands = input.decision.recommendedCommands.slice(0, Math.max(input.limit, 0));
  const results: OverseerCommandExecution[] = [];
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];
    const commandIndex = index + 1;
    const baseResult = {
      command: command.command,
      purpose: command.purpose,
      expectedStateChange: command.expectedStateChange,
    };
    if (command.requiresHuman) {
      const blocked = {
        ...baseResult,
        status: "blocked" as const,
        reason: "Command requires human approval.",
      };
      recordOverseerCommandBlocked(input, blocked, commandIndex);
      results.push(blocked);
      continue;
    }

    const validation = validateOverseerCommand(command.command, input.workspace, input.store);
    if (!validation.ok) {
      const blocked = {
        ...baseResult,
        status: "blocked" as const,
        reason: validation.reason,
      };
      recordOverseerCommandBlocked(input, blocked, commandIndex);
      results.push(blocked);
      continue;
    }

    input.store.upsertHeartbeat({
      id: `heartbeat:${input.actor}`,
      actor: input.actor,
      state: validation.category === "child_agent" ? "waiting" : "testing",
      detail:
        validation.category === "child_agent"
          ? `Dispatching ${validation.childRole} for ${validation.sliceId}`
          : `Executing overseer command ${commandIndex}: ${validation.commandKey}`,
      entityType: "harness",
      entityId: input.entityId,
    });
    input.store.addEvent(
      createEvent({
        actor: input.actor,
        type: "overseer.command_started",
        entityType: "harness",
        entityId: input.entityId,
        payload: {
          runId: input.runId,
          index: commandIndex,
          command: command.command,
          commandKey: validation.commandKey,
          category: validation.category,
          childRole: validation.childRole,
          sliceId: validation.sliceId,
          purpose: command.purpose,
          expectedStateChange: command.expectedStateChange,
        },
      }),
    );

    const stdoutPath = path.join(input.artifactPath, `overseer-command-${input.runId}-${commandIndex}.stdout.log`);
    const stderrPath = path.join(input.artifactPath, `overseer-command-${input.runId}-${commandIndex}.stderr.log`);
    const result = spawnSync(process.execPath, [process.argv[1], ...validation.cliArgs], {
      cwd: input.workspace,
      shell: false,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    fs.writeFileSync(stdoutPath, result.stdout ?? "", "utf8");
    fs.writeFileSync(stderrPath, result.stderr ?? "", "utf8");

    const execution: OverseerCommandExecution = {
      ...baseResult,
      commandKey: validation.commandKey,
      category: validation.category,
      childRole: validation.childRole,
      sliceId: validation.sliceId,
      status: result.status === 0 ? "executed" : "failed",
      exitCode: result.status,
      stdoutPath,
      stderrPath,
      reason: result.status === 0 ? undefined : result.error?.message ?? `Command exited with status ${result.status}`,
    };
    input.store.addEvent(
      createEvent({
        actor: input.actor,
        type: result.status === 0 ? "overseer.command_completed" : "overseer.command_failed",
        entityType: "harness",
        entityId: input.entityId,
        payload: {
          runId: input.runId,
          index: commandIndex,
          command: command.command,
          commandKey: validation.commandKey,
          category: validation.category,
          childRole: validation.childRole,
          sliceId: validation.sliceId,
          exitCode: result.status,
          stdoutPath,
          stderrPath,
          reason: execution.reason,
          purpose: command.purpose,
          expectedStateChange: command.expectedStateChange,
        },
      }),
    );
    results.push(execution);
  }

  input.store.upsertHeartbeat({
    id: `heartbeat:${input.actor}`,
    actor: input.actor,
    state: results.some((item) => item.status === "failed") ? "blocked" : "idle",
    detail: summarizeOverseerCommandResults(results),
    entityType: "harness",
    entityId: input.entityId,
  });
  return results;
}

function recordOverseerCommandBlocked(
  input: {
    store: SwarmStore;
    actor: string;
    entityId: string;
    runId: string;
  },
  blocked: OverseerCommandExecution,
  commandIndex: number,
): void {
  input.store.addEvent(
    createEvent({
      actor: input.actor,
      type: "overseer.command_blocked",
      entityType: "harness",
      entityId: input.entityId,
      payload: {
        runId: input.runId,
        index: commandIndex,
        command: blocked.command,
        reason: blocked.reason,
        purpose: blocked.purpose,
        expectedStateChange: blocked.expectedStateChange,
      },
    }),
  );
}

function summarizeOverseerCommandResults(results: OverseerCommandExecution[]): string {
  if (results.length === 0) return "Overseer decision recorded; no commands executed.";
  const executed = results.filter((item) => item.status === "executed").length;
  const blocked = results.filter((item) => item.status === "blocked").length;
  const failed = results.filter((item) => item.status === "failed").length;
  return `Overseer commands complete: executed ${executed}, blocked ${blocked}, failed ${failed}.`;
}

function validateOverseerCommand(
  command: string,
  workspace: string,
  store: SwarmStore,
): OverseerCommandValidation {
  const tokens = tokenizeCommand(command);
  if (!tokens.ok) return tokens;
  if (tokens.args.some((token) => [";", "&&", "||", "|", ">", "<", "`"].includes(token))) {
    return { ok: false, reason: "Shell operators are not allowed in overseer commands." };
  }
  if (tokens.args.length < 3) return { ok: false, reason: "Expected command shape: node <cli.js> <command> ..." };
  const [runtime, cliPath, ...cliArgs] = tokens.args;
  const runtimeName = path.basename(runtime).toLowerCase();
  if (runtimeName !== "node" && runtimeName !== "node.exe") {
    return { ok: false, reason: "Only node-based harness commands may be executed." };
  }
  if (path.basename(cliPath).toLowerCase() !== "cli.js") {
    return { ok: false, reason: "Only the harness CLI entrypoint may be executed." };
  }
  const resolvedCli = path.resolve(workspace, cliPath);
  const currentCli = path.resolve(process.argv[1]);
  const normalizedCli = resolvedCli.toLowerCase();
  const normalizedCurrent = currentCli.toLowerCase();
  if (normalizedCli !== normalizedCurrent && path.resolve(cliPath).toLowerCase() !== normalizedCurrent && !cliPath.replace(/\\/g, "/").endsWith("/dist/cli.js")) {
    return { ok: false, reason: "The command does not target this harness CLI." };
  }
  if (cliArgs.length === 0) return { ok: false, reason: "Missing harness subcommand." };
  const [commandName, subcommand] = cliArgs;
  if (commandName === "observe") return { ok: true, cliArgs, commandKey: "observe", category: "state" };
  if (commandName === "sources" && subcommand === "list") {
    return { ok: true, cliArgs, commandKey: "sources list", category: "state" };
  }
  if (commandName === "domains" && (subcommand === "list" || subcommand === "inspect")) {
    return { ok: true, cliArgs, commandKey: `domains ${subcommand}`, category: "state" };
  }
  if (commandName === "slices" && subcommand === "pull") {
    return { ok: true, cliArgs, commandKey: "slices pull", category: "state" };
  }
  if (commandName === "run") {
    return validateOverseerChildDispatch({
      store,
      cliArgs,
      commandName,
      childRole: "worker",
      allowedStatuses: new Set(["ready", "blocked", "repairing"]),
    });
  }
  if (commandName === "review") {
    return validateOverseerChildDispatch({
      store,
      cliArgs,
      commandName,
      childRole: "reviewer",
      allowedStatuses: new Set(["implemented", "ready_for_review", "repairing"]),
      requireWorkerEvidence: true,
    });
  }
  if (commandName === "verify") {
    return {
      ok: false,
      reason: "Phase 5B does not execute deterministic verification commands yet; dispatch worker/reviewer agents first.",
    };
  }
  if (["checkpoint", "escalations"].includes(commandName)) {
    return { ok: false, reason: "Phase 5B records overseer decisions directly and does not execute checkpoint/escalation commands." };
  }
  return { ok: false, reason: `Command is not allowlisted for Phase 5B: ${commandName}${subcommand ? ` ${subcommand}` : ""}` };
}

function validateOverseerChildDispatch(input: {
  store: SwarmStore;
  cliArgs: string[];
  commandName: "run" | "review";
  childRole: "worker" | "reviewer";
  allowedStatuses: Set<SliceRecord["status"]>;
  requireWorkerEvidence?: boolean;
}): OverseerCommandValidation {
  const [, sliceId, ...options] = input.cliArgs;
  if (!sliceId || sliceId.startsWith("-")) {
    return { ok: false, reason: `Missing slice id for ${input.commandName} child-agent dispatch.` };
  }
  const optionValidation = validateChildDispatchOptions(options);
  if (!optionValidation.ok) return optionValidation;
  if (!optionValidation.actor) {
    return { ok: false, reason: "Phase 5B child-agent dispatch requires an explicit --actor for visibility." };
  }
  if ((optionValidation.driver ?? "codex") !== "codex") {
    return { ok: false, reason: "Phase 5B child-agent dispatch requires --driver codex." };
  }

  const slice = input.store.listSlices().find((item) => item.id === sliceId);
  if (!slice) return { ok: false, reason: `Cannot dispatch ${input.childRole}; slice not found: ${sliceId}` };
  if (!input.allowedStatuses.has(slice.status)) {
    return {
      ok: false,
      reason: `Cannot dispatch ${input.childRole} for slice ${slice.id} while status is ${slice.status}.`,
    };
  }

  const activeChildRun = input.store
    .listAgentRuns()
    .find(
      (run) =>
        run.entityType === "slice" &&
        run.entityId === slice.id &&
        run.status === "running" &&
        (run.role === "worker" || run.role === "reviewer"),
    );
  if (activeChildRun) {
    return {
      ok: false,
      reason: `Cannot dispatch ${input.childRole}; ${activeChildRun.role} run ${activeChildRun.id} is still running for ${slice.id}.`,
    };
  }

  if (input.requireWorkerEvidence && !input.store.listEvidence(slice.id).some((item) => item.kind === "worker_result")) {
    return { ok: false, reason: `Cannot dispatch reviewer for ${slice.id}; no worker_result evidence exists yet.` };
  }

  return {
    ok: true,
    cliArgs: input.cliArgs,
    commandKey: input.commandName,
    category: "child_agent",
    childRole: input.childRole,
    sliceId: slice.id,
  };
}

function validateChildDispatchOptions(
  options: string[],
): { ok: true; actor?: string; driver?: string } | { ok: false; reason: string } {
  const allowedOptions = new Set(["--actor", "--driver", "--model"]);
  let actor: string | undefined;
  let driver: string | undefined;
  for (let index = 0; index < options.length; index += 1) {
    const token = options[index];
    if (!token.startsWith("--")) {
      return { ok: false, reason: `Unexpected positional argument in child-agent dispatch: ${token}` };
    }
    if (!allowedOptions.has(token)) {
      return { ok: false, reason: `Unsupported child-agent dispatch option: ${token}` };
    }
    const value = options[index + 1];
    if (!value || value.startsWith("--")) {
      return { ok: false, reason: `Missing value for child-agent dispatch option: ${token}` };
    }
    if (token === "--actor") actor = value;
    if (token === "--driver") driver = value;
    index += 1;
  }
  return { ok: true, actor, driver };
}

function tokenizeCommand(command: string): { ok: true; args: string[] } | { ok: false; reason: string } {
  const args: string[] = [];
  let current = "";
  let quote: "\"" | "'" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if ((char === "\"" || char === "'") && !quote) {
      quote = char;
      continue;
    }
    if (quote && char === quote) {
      quote = undefined;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (quote) return { ok: false, reason: "Command has an unclosed quote." };
  if (current) args.push(current);
  return { ok: true, args };
}

function jsonForPrompt(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  const maxLength = 30000;
  if (json.length <= maxLength) return json;
  return `${json.slice(0, maxLength)}\n... truncated ${json.length - maxLength} chars ...`;
}

function buildWorkerPrompt(input: {
  slice: SliceRecord;
  targetPath: string;
  laneName?: string;
}): string {
  const sourceRefs = input.slice.sourceRefs
    .map((source) => `- ${source.title ?? source.uri}: ${source.uri}`)
    .join("\n");
  return `You are an implementation worker inside the Agent Swarm MVP harness.

Target workspace:
${input.targetPath}

Lane:
${input.laneName ?? input.slice.laneId}

Slice:
${input.slice.id} - ${input.slice.title}

Delivery question:
${input.slice.deliveryQuestion}

Work package:
- type: ${input.slice.workPackageType}
- minimum meaningful outcome: ${input.slice.minimumMeaningfulOutcome}
${input.slice.acSizedExceptionReason ? `- AC-sized exception: ${input.slice.acSizedExceptionReason}` : ""}

Immutable source refs:
${sourceRefs}

FR/AC scope:
${input.slice.frAcRefs.map((ref) => `- ${ref}`).join("\n")}

Scope:
${input.slice.scope.map((item) => `- ${item}`).join("\n")}

Out of scope:
${input.slice.outOfScope.map((item) => `- ${item}`).join("\n")}

Expected evidence:
${input.slice.expectedEvidence.map((item) => `- ${item}`).join("\n")}

Verification requirements:
${input.slice.verificationRequirements.map((item) => `- ${item}`).join("\n")}

Instructions:
- Implement only this slice scope.
- Do not modify source spec files.
- Prefer minimal, behavior-focused changes.
- Run relevant target tests if available.
- Provide frAcCoverage for every in-scope FR/AC ref.
- Return the final answer in the required structured schema.
`;
}

function writeWorkerResultSchema(schemaPath: string): void {
  fs.mkdirSync(path.dirname(schemaPath), { recursive: true });
  fs.writeFileSync(
    schemaPath,
    `${JSON.stringify(
      {
        type: "object",
        additionalProperties: false,
        required: [
          "status",
          "summary",
          "changedFiles",
          "commandsRun",
          "testsRun",
          "frAcCoverage",
          "risks",
          "nextRecommendation",
        ],
        properties: {
          status: { type: "string", enum: ["passed", "failed", "blocked", "needs_human"] },
          summary: { type: "string" },
          changedFiles: { type: "array", items: { type: "string" } },
          commandsRun: { type: "array", items: { type: "string" } },
          testsRun: { type: "array", items: { type: "string" } },
          frAcCoverage: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["ref", "status", "evidence"],
              properties: {
                ref: { type: "string" },
                status: { type: "string", enum: ["covered", "not_covered", "blocked"] },
                evidence: { type: "string" },
              },
            },
          },
          risks: { type: "array", items: { type: "string" } },
          nextRecommendation: { type: "string" },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function writeReviewResultSchema(schemaPath: string): void {
  fs.mkdirSync(path.dirname(schemaPath), { recursive: true });
  fs.writeFileSync(
    schemaPath,
    `${JSON.stringify(
      {
        type: "object",
        additionalProperties: false,
        required: [
          "status",
          "summary",
          "frAcFindings",
          "testAssessment",
          "sourceMutationDetected",
          "stubOrHardcodeRisk",
          "requiredFixes",
          "escalations",
          "recommendation",
        ],
        properties: {
          status: { type: "string", enum: ["accepted", "repair_required", "blocked", "human_required"] },
          summary: { type: "string" },
          frAcFindings: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["ref", "status", "evidence", "finding"],
              properties: {
                ref: { type: "string" },
                status: { type: "string", enum: ["passed", "failed", "missing_evidence", "uncertain"] },
                evidence: { type: "array", items: { type: "string" } },
                finding: { type: "string" },
              },
            },
          },
          testAssessment: { type: "string" },
          sourceMutationDetected: { type: "boolean" },
          stubOrHardcodeRisk: { type: "string", enum: ["none", "low", "medium", "high"] },
          requiredFixes: { type: "array", items: { type: "string" } },
          escalations: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["level", "message"],
              properties: {
                level: { type: "string", enum: ["warning", "blocker", "human_required", "critical"] },
                message: { type: "string" },
              },
            },
          },
          recommendation: { type: "string" },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function writeOverseerDecisionSchema(schemaPath: string): void {
  fs.mkdirSync(path.dirname(schemaPath), { recursive: true });
  fs.writeFileSync(
    schemaPath,
    `${JSON.stringify(
      {
        type: "object",
        additionalProperties: false,
        required: [
          "status",
          "summary",
          "scenario",
          "currentPriority",
          "recommendedCommands",
          "lanePlan",
          "blockers",
          "stopCondition",
          "nextAction",
        ],
        properties: {
          status: { type: "string", enum: ["recommend_commands", "blocked", "human_required", "complete"] },
          summary: { type: "string" },
          scenario: { type: "string" },
          currentPriority: { type: "string" },
          recommendedCommands: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["command", "purpose", "expectedStateChange", "requiresHuman"],
              properties: {
                command: { type: "string" },
                purpose: { type: "string" },
                expectedStateChange: { type: "string" },
                requiresHuman: { type: "boolean" },
              },
            },
          },
          lanePlan: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["laneName", "purpose", "nextAction"],
              properties: {
                laneName: { type: "string" },
                purpose: { type: "string" },
                nextAction: { type: "string" },
              },
            },
          },
          blockers: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["level", "message", "scope"],
              properties: {
                level: { type: "string", enum: ["warning", "blocker", "human_required", "critical"] },
                message: { type: "string" },
                scope: { type: "string" },
              },
            },
          },
          stopCondition: { type: "string" },
          nextAction: { type: "string" },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}
