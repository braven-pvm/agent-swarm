#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync, type ChildProcess } from "node:child_process";
import spawn from "cross-spawn";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import YAML from "yaml";
import { createEvent } from "./events.js";
import { runOnboard } from "./onboard.js";
import { checkProvider } from "./provider-check.js";
import { runFixtureWorker } from "./fixture-worker.js";
import { makeId } from "./ids.js";
import {
  artifactsDir,
  resolveWorkspace,
  swarmDir,
  sanitizeArtifactSegment,
  formatGitSafeDirectoryPath,
  trimOutput,
  summarizePromptPayload,
} from "./paths.js";
import { pullNextSlice } from "./planner.js";
import { overseerDecisionSchema, reviewResultSchema, workerResultSchema, type OverseerDecision, type ReviewResult } from "./schemas.js";
import { registerFileSource } from "./source-adapter.js";
import { SwarmStore } from "./storage.js";
import { createWebViewerServer } from "./web-server.js";
import { initTarget } from "./target-init.js";
import { createWorkerJsonlIngestor, extractSessionIdFromWorkerJsonl, ingestWorkerJsonl } from "./worker-events.js";
import { loadProtocol } from "./protocol.js";
import { prepareSkillBindings, type SkillBindingResult } from "./skills.js";
import type { SkillIsolationFinding } from "./skill-isolation.js";
import { getWorkerDriver, workerDriverIds, type WorkerRunSpec, type WorkerFinalization } from "./worker-driver.js";
import { recordHumanVerification } from "./human-actions.js";
import { buildResumePacket, refreshCheckpoint } from "./checkpoints.js";
import { buildDomainDetail, buildDomainSummaries } from "./domains.js";
import { sourceDomain, sourceFrAcRefs, sourcePriority, sourceSections, sourceTags, type SourceIndexMetadata } from "./source-index.js";
import {
  RUN_MODE_META_KEY,
  DEFAULT_RUN_MODE,
  buildObservabilitySnapshot,
  buildSliceReport,
  buildTimeline,
  buildGraph,
  renderDot,
  findSource,
  searchSpecSections,
  parseOptionalPositiveInteger,
  currentDependencyStatus,
  currentRunMode,
  parseRunMode,
  defaultLiveRunHistoryRoot,
  listLiveRunHistory,
  loadLiveRunHistoryDetail,
  compareLiveRunHistory,
  latestFrAcResults,
  stringValue,
} from "./observability.js";
import {
  buildRunFocusPacket,
  buildSliceFocusPacket,
  buildOverseerFocusQueue,
  type RunFocusPacket,
  type SliceFocusPacket,
} from "./focus.js";
import type {
  AgentRunRecord,
  CheckpointRecord,
  CheckpointRole,
  EntityType,
  EscalationRecord,
  EvidenceRecord,
  FrAcVerificationResult,
  HarnessEvent,
  HeartbeatRecord,
  HeartbeatState,
  SliceRecord,
  SourceRecord,
} from "./types.js";

const program = new Command();
const cliRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type WorkerRunResult = {
  sliceId: string;
  runId: string;
  ok: boolean;
  exitCode: number | null;
  promptPath: string;
  eventsPath: string;
  resultPath: string;
  workerEvents: ReturnType<typeof ingestWorkerJsonl>;
  stderr?: string;
};

type ReviewRunResult = {
  sliceId: string;
  runId: string;
  exitCode: number | null;
  promptPath: string;
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

type SliceRepairContext = {
  review?: {
    evidenceId: string;
    status: ReviewResult["status"];
    summary: string;
    recommendation: string;
    requiredFixes: string[];
    nonPassingRefs: string[];
    createdAt: string;
  };
  humanFeedback: Array<{
    evidenceId: string;
    ref?: string;
    status?: string;
    actor?: string;
    notes?: string;
    packetId?: string;
    createdAt: string;
  }>;
  activeEscalations: Array<{
    id: string;
    level: EscalationRecord["level"];
    message: string;
    reason?: string;
  }>;
};

type WorkerStreamingResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  workerEvents: ReturnType<typeof ingestWorkerJsonl>;
  idleTimedOut?: boolean;
};

type ScenarioManifestLoad = {
  path: string;
  exists: boolean;
  data: Record<string, unknown>;
};

type LiveAgentSmokeRunOptions = {
  reset?: boolean;
  workspace?: string;
  driver?: string;
  scenario?: string;
  fault?: string;
  maxTurns?: number;
  maxRuntimeSeconds?: number;
  executeLimit?: number;
  maxSlices?: number;
  maxAgentRuns?: number;
  maxRepairAttempts?: number;
  summary?: string;
  artifacts?: string;
  historyRoot?: string;
  runId?: string;
  history?: boolean;
};

type LiveAgentSmokeResetOptions = {
  workspace?: string;
  scenario?: string;
  stopRelatedProcesses?: boolean;
};

type LiveAgentSmokeFakeOptions = {
  reset?: boolean;
  workspace?: string;
  scenario?: string;
  summary?: string;
  artifacts?: string;
};

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
  .command("onboard")
  .description("Set up agent-swarm in the current repo: init, target, gitignore, and a sample spec")
  .option("--source <path>", "register this existing spec file instead of scaffolding a sample")
  .option("--name <name>", "target name (default: repo directory name)")
  .action((options: { source?: string; name?: string }) => {
    const workspace = resolveWorkspace();
    const result = runOnboard({ workspace, source: options.source, name: options.name });
    const relSource = path.relative(workspace, result.sourceUri) || result.sourceUri;
    console.log(`Onboarded agent-swarm in ${workspace}`);
    if (!result.isGitRepo) console.log("  warning: not a git repo — lanes/worktrees and real runs expect git; setup continued.");
    console.log(`  state: ${swarmDir(workspace)}/state.db`);
    console.log(`  target: ${result.targetName} (${result.wroteTargetConfig ? "configured" : "already configured"})`);
    console.log(`  gitignore: ${result.gitignoreAdded ? "managed block added" : "already present"}`);
    console.log(`  source: ${result.sourceTitle} (${result.refsIndexed} refs)${result.scaffoldedSample ? " [sample scaffolded]" : ""}`);
    console.log("");
    console.log("Next steps:");
    console.log(`  swarm slices pull --target ${result.targetName} --source ${relSource}   # form your first slice`);
    console.log("  swarm check claude        # confirm your provider is installed and launchable");
    console.log("  swarm run --driver claude <slice-id>   # your first real worker run");
    console.log("  swarm serve               # open the read-only viewer");
    if (result.scaffoldedSample) console.log(`  (replace ${relSource} with your real specs)`);
  });

program
  .command("check")
  .description("Check that a worker driver is installed and launchable")
  .argument("[provider]", "driver to check (e.g. claude, codex); defaults to the protocol default driver")
  .option("--live", "additionally do a tiny real call to confirm auth (spends a small amount)")
  .action(async (provider: string | undefined, options: { live?: boolean }) => {
    const driver = provider ?? loadProtocol(resolveWorkspace()).protocol.workers.defaultDriver;
    if (driver === "fixture") {
      console.log("fixture is an in-process driver — no external command to check.");
      return;
    }
    const result = await checkProvider({ driver, live: options.live });
    console.log(`driver: ${result.driver}`);
    console.log(`  command: ${result.command}${result.prefixArgs.length ? ` ${result.prefixArgs.join(" ")}` : ""}`);
    if (result.launchable) {
      console.log(`  launchable: yes${result.version ? ` (${result.version})` : ""}`);
      if (result.live) console.log(`  live auth: ${result.live.ok ? "ok" : "failed"} — ${result.live.detail}`);
    } else {
      console.log(`  launchable: no — ${result.error}`);
      console.log(`  fix: install the ${driver} CLI and ensure it is on PATH, or set SWARM_${driver.toUpperCase()}_COMMAND.`);
      process.exitCode = 1;
    }
  });

program
  .command("status")
  .description("Show current harness status")
  .action(() => {
    printStatus();
  });

const smokeCommand = program.command("smoke").description("Run resettable smoke harness scenarios");
const liveAgentSmokeCommand = smokeCommand.command("live-agent").description("Run the live-agent smoke harness");

liveAgentSmokeCommand
  .command("reset")
  .description("Reset and initialize the disposable live-agent smoke workspace")
  .option("--workspace <path>", "workspace to reset; defaults to .swarm-demo/live-agent-smoke")
  .option("--scenario <scenario>", "scenario id", "live-agent-smoke")
  .option("--stop-related-processes", "stop related viewer/product processes before reset")
  .action((options: LiveAgentSmokeResetOptions) => {
    const args = buildLiveAgentResetArgs(options);
    runRepoScript("scripts/reset-live-agent-smoke.mjs", args);
  });

liveAgentSmokeCommand
  .command("run")
  .description("Run the autonomous acceptance-loop live-agent smoke")
  .option("--reset", "reset the smoke workspace before running")
  .option("--workspace <path>", "workspace to run; defaults to .swarm-demo/live-agent-smoke")
  .option("--driver <driver>", "agent driver", "codex")
  .option("--scenario <scenario>", "scenario id", "live-agent-smoke")
  .option("--fault <mode>", "fault injection mode", "none")
  .option("--max-turns <count>", "maximum overseer turns", parseInteger)
  .option("--max-runtime-seconds <count>", "maximum runtime in seconds", parseInteger)
  .option("--execute-limit <count>", "maximum overseer commands per turn", parseInteger)
  .option("--max-slices <count>", "maximum slices to coordinate", parseInteger)
  .option("--max-agent-runs <count>", "maximum child agent runs", parseInteger)
  .option("--max-repair-attempts <count>", "maximum worker/reviewer repair attempts for one slice before blocking", parseInteger)
  .option("--summary <path>", "summary output path")
  .option("--artifacts <path>", "artifact output directory")
  .option("--history-root <path>", "durable run-history root")
  .option("--run-id <id>", "explicit run id")
  .option("--no-history", "disable durable run-history archiving")
  .action((options: LiveAgentSmokeRunOptions) => {
    const args = buildLiveAgentRunArgs("acceptance-loop", options);
    runRepoScript(liveAgentRunScriptFor(options.scenario), args);
  });

liveAgentSmokeCommand
  .command("full")
  .description("Run the full-product live-agent smoke")
  .option("--reset", "reset the smoke workspace before running")
  .option("--workspace <path>", "workspace to run; defaults to .swarm-demo/live-agent-smoke")
  .option("--driver <driver>", "agent driver", "codex")
  .option("--scenario <scenario>", "scenario id", "live-agent-smoke")
  .option("--max-turns <count>", "maximum overseer turns", parseInteger, 80)
  .option("--max-runtime-seconds <count>", "maximum runtime in seconds", parseInteger, 7200)
  .option("--execute-limit <count>", "maximum overseer commands per turn", parseInteger, 4)
  .option("--max-slices <count>", "maximum slices to coordinate", parseInteger, 20)
  .option("--max-agent-runs <count>", "maximum child agent runs", parseInteger, 150)
  .option("--max-repair-attempts <count>", "maximum worker/reviewer repair attempts for one slice before blocking", parseInteger, 8)
  .option("--summary <path>", "summary output path")
  .option("--artifacts <path>", "artifact output directory")
  .option("--history-root <path>", "durable run-history root")
  .option("--run-id <id>", "explicit run id")
  .option("--no-history", "disable durable run-history archiving")
  .action((options: LiveAgentSmokeRunOptions) => {
    const args = buildLiveAgentRunArgs("full-product", options);
    runRepoScript(liveAgentRunScriptFor(options.scenario), args);
  });

liveAgentSmokeCommand
  .command("fake")
  .description("Run a deterministic fake-agent E2E for a live-agent smoke scenario")
  .option("--reset", "reset the smoke workspace before running")
  .option("--workspace <path>", "workspace to run; defaults to .swarm-demo/live-agent-smoke-h2")
  .option("--scenario <scenario>", "scenario id", "live-agent-smoke-h2")
  .option("--summary <path>", "summary output path")
  .option("--artifacts <path>", "artifact output directory")
  .action((options: LiveAgentSmokeFakeOptions) => {
    const args = buildLiveAgentFakeArgs(options);
    runRepoScript("scripts/run-support-triage-fake-demo.mjs", args);
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
  .option("--driver <driver>", "overseer driver (fixture or a registered driver)", "codex")
  .option("--scenario <scenario>", "scenario id from the live smoke manifest", "live-agent-smoke")
  .option("--model <model>", "model override passed to the overseer driver")
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
      const obligationIssues = validateVerificationObligations(slice);
      if (obligationIssues.length > 0) {
        throw new Error(`Slice ${slice.id} has invalid verification obligations: ${obligationIssues.join("; ")}`);
      }
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
          payload: { command, cwd: target.path, verificationObligations: summarizeVerificationObligations(slice) },
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
      let frAcResults = buildFrAcResults({
        slice,
        verifier: options.actor,
        commandPassed,
        reviewGate,
        workerGate,
        verificationEvidenceId,
      });
      const humanVerificationPackets = writeHumanVerificationPackets({
        workspace,
        store,
        slice,
        target,
        verifier: options.actor,
        command,
        commandPassed,
        workerGate,
        reviewGate,
        verificationEvidenceId,
        frAcResults,
      });
      frAcResults = attachHumanVerificationPacketEvidence(frAcResults, humanVerificationPackets);
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
          verificationObligations: summarizeVerificationObligations(slice),
          frAcResults,
          missingRefs: frAcResults.filter((item) => item.status === "missing_evidence").map((item) => item.ref),
          failedRefs: frAcResults.filter((item) => item.status === "failed").map((item) => item.ref),
          humanVerificationRefs: frAcResults.filter((item) => item.status === "awaiting_human_verification").map((item) => item.ref),
          humanInputRequiredRefs: frAcResults.filter((item) => item.status === "human_input_required").map((item) => item.ref),
          humanVerificationPackets,
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
            verificationObligations: summarizeVerificationObligations(slice),
            frAcResults,
            missingRefs: frAcResults.filter((item) => item.status === "missing_evidence").map((item) => item.ref),
            failedRefs: frAcResults.filter((item) => item.status === "failed").map((item) => item.ref),
            humanVerificationRefs: frAcResults.filter((item) => item.status === "awaiting_human_verification").map((item) => item.ref),
            humanInputRequiredRefs: frAcResults.filter((item) => item.status === "human_input_required").map((item) => item.ref),
            humanVerificationPackets,
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
      const humanVerificationRefs = frAcResults.filter((item) => item.status === "awaiting_human_verification").map((item) => item.ref);
      if (missingRefs.length > 0) console.log(`  missing FR/AC evidence: ${missingRefs.join(", ")}`);
      if (failedRefs.length > 0) console.log(`  failed FR/AC evidence: ${failedRefs.join(", ")}`);
      if (humanVerificationRefs.length > 0) {
        console.log(`  awaiting human verification: ${humanVerificationRefs.join(", ")}`);
        for (const packet of humanVerificationPackets) {
          console.log(`  human packet ${packet.ref}: ${packet.markdownPath}`);
        }
      }
      if (result.stdout.trim()) console.log(result.stdout.trim());
      if (result.stderr.trim()) console.error(result.stderr.trim());
    } finally {
      store.close();
    }
  });

program
  .command("human-verify")
  .description("Record a human verification result for a human-verification-required FR/AC")
  .argument("<slice-id>", "slice identifier")
  .argument("<ref>", "FR/AC ref to sign off")
  .requiredOption("--status <status>", "human_verified, failed, or needs_rework")
  .option("--actor <actor>", "human actor id shown in observability", "human")
  .option("--notes <notes>", "human verification notes", "")
  .action((sliceId: string, ref: string, options: { status: string; actor: string; notes: string }) => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      const result = recordHumanVerification(store, {
        sliceId,
        ref,
        status: options.status,
        actor: options.actor,
        notes: options.notes,
      });
      const packetEvidence = store.listEvidence(sliceId).find((item) => item.id === result.packetEvidenceId);
      const markdownPath = packetEvidence ? stringValue(packetEvidence.payload.markdownPath) : undefined;
      console.log(`Human verification ${result.status} recorded for ${ref}`);
      console.log(`  slice: ${result.sliceId}`);
      if (markdownPath) console.log(`  packet: ${markdownPath}`);
      console.log(`  final slice status: ${result.finalSliceStatus}`);
      if (!result.accepted) console.log(`  acceptance remains blocked until all refs are passed, human_verified, or overridden`);
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

const inspect = program.command("inspect").description("Build overseer focus packets for runs and slices");

inspect
  .command("run")
  .description("Inspect one agent run with prompt, event, artifact, heartbeat, and failure context")
  .argument("<run-id>", "agent run identifier")
  .option("--json", "print the focus packet as JSON")
  .option("--events <count>", "worker/reviewer/overseer JSONL events to include", parseInteger, 20)
  .action((runId: string, options: { json?: boolean; events: number }) => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      const packet = buildRunFocusPacket(store, workspace, runId, { eventLimit: options.events });
      if (options.json) {
        console.log(JSON.stringify(packet, null, 2));
        return;
      }
      console.log(renderRunFocusPacket(packet));
    } finally {
      store.close();
    }
  });

inspect
  .command("slice")
  .description("Inspect a slice with its agent runs, evidence, escalations, and latest focus signals")
  .argument("<slice-id>", "slice identifier")
  .option("--json", "print the focus packet as JSON")
  .option("--runs <count>", "recent runs to include", parseInteger, 5)
  .option("--events <count>", "JSONL events to include per latest run", parseInteger, 12)
  .action((sliceId: string, options: { json?: boolean; runs: number; events: number }) => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      const packet = buildSliceFocusPacket(store, workspace, sliceId, { runLimit: options.runs, eventLimit: options.events });
      if (options.json) {
        console.log(JSON.stringify(packet, null, 2));
        return;
      }
      console.log(renderSliceFocusPacket(packet));
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
  .option("--web-dist <path>", "path to the built Command Bridge UI (web/dist)")
  .action((options: { workspace: string; host: string; port: number; events: number; historyRoot?: string; webDist?: string }) => {
    const workspace = path.resolve(options.workspace);
    ensureInitialized(workspace);
    const historyRoot = options.historyRoot ? path.resolve(options.historyRoot) : defaultLiveRunHistoryRoot(workspace);
    const webDistPath = options.webDist
      ? path.resolve(options.webDist)
      : fileURLToPath(new URL("../web/dist", import.meta.url));
    const server = createWebViewerServer({ workspace, defaultEventCount: options.events, historyRoot, webDistPath });
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
      process.env.SWARM_CONTROL_HOST = options.host;
      process.env.SWARM_CONTROL_PORT = String(port);
      console.log("Agent Swarm web observability viewer");
      console.log(`  workspace: ${workspace}`);
      console.log(`  history: ${historyRoot}`);
      console.log(`  url: http://${options.host}:${port}/`);
      console.log("  mode: local trusted control");
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
      const recoveredSessionId = previousRun.sessionId ?? sessionIdFromAgentRunEvents(previousRun);
      if (!recoveredSessionId) throw new Error(`Agent run ${runId} does not have a captured worker session id.`);
      if (!previousRun.sessionId) store.updateAgentRun(previousRun.id, { sessionId: recoveredSessionId });
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
      const promptPath = path.join(artifactPath, `worker-revive-prompt-${revivedRunId}.md`);
      const schemaPath = path.join(workspace, "schemas", "worker-result.schema.json");
      writeWorkerResultSchema(schemaPath);
      const lane = store.listLanes().find((item) => item.id === slice.laneId);
      const priorResultState =
        previousRun.resultPath && fs.existsSync(previousRun.resultPath)
          ? `Prior structured result exists at ${previousRun.resultPath}. Inspect it only if needed.`
          : "No prior structured worker result artifact was captured for this run.";
      const protocol = loadProtocol(target.path);
      const skillBinding = prepareSkillBindings({
        workspace,
        targetPath: target.path,
        artifactPath,
        runId: revivedRunId,
        role: "recovery",
        protocol,
      });
      const prompt = buildWorkerRevivePrompt({
        slice,
        targetPath: target.path,
        laneName: lane?.name,
        previousRunId: previousRun.id,
        previousStatus: previousRun.status,
        priorResultState,
        skillPacket: skillBinding.promptSection,
      });
      fs.writeFileSync(promptPath, prompt, "utf8");

      store.insertAgentRun({
        id: revivedRunId,
        sliceId: slice.id,
        role: previousRun.role ?? "worker",
        entityType: "slice",
        entityId: slice.id,
        actor: previousRun.actor,
        driver: previousRun.driver,
        status: "running",
        sessionId: recoveredSessionId,
        attempt,
        eventsPath: jsonlPath,
        startedAt: now,
        updatedAt: now,
      });
      store.updateSliceStatus(slice.id, "implementing");
      store.upsertHeartbeat({
        id: `heartbeat:${previousRun.actor}`,
        actor: previousRun.actor,
        state: "thinking",
        detail: `Reviving worker session ${recoveredSessionId}`,
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
            sessionId: recoveredSessionId,
            attempt,
            promptPath,
            eventsPath: jsonlPath,
            skills: summarizeSkillBinding(skillBinding),
            skillBindingPath: skillBinding.bindingPath,
            skillPacketPath: skillBinding.packetPath,
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

      const spec: WorkerRunSpec = {
        prompt,
        targetPath: target.path,
        schemaPath,
        resultPath: lastMessagePath,
        model: options.model,
        resumeSessionId: recoveredSessionId,
        driverConfig: protocol.protocol.workers.drivers[previousRun.driver] ?? {},
      };
      const invocation = adapter.buildInvocation(spec);
      const result = await spawnWorkerStreaming({
        command: invocation.command,
        args: invocation.args,
        stdin: invocation.stdin,
        cwd: target.path,
        jsonlPath,
        actor: previousRun.actor,
        sliceId: slice.id,
        store,
        driver: previousRun.driver,
        runId: revivedRunId,
        classify: adapter.classifyHeartbeat?.bind(adapter),
        idleTimeoutMs: agentIdleTimeoutMsForProtocol(protocol),
      });
      const finalization = adapter.finalize({ exitCode: result.status, stdout: result.stdout ?? "", spec });
      const stderrPath = result.stderr ? path.join(artifactPath, `worker-revive-${revivedRunId}-stderr.log`) : undefined;
      if (stderrPath && result.stderr) fs.writeFileSync(stderrPath, result.stderr, "utf8");
      const workerEvents = result.workerEvents;
      store.updateAgentRun(revivedRunId, {
        status: finalization.ok ? "completed" : "failed",
        sessionId: workerEvents.sessionId ?? recoveredSessionId,
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
      if (finalization.ok) {
        clearSupersededRecoveryEscalations({
          store,
          previousRun,
          newRunId: revivedRunId,
          actor: options.actor,
          recoveryKind: "revive",
        });
      }
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
            resultArtifactRecovered: finalization.resultArtifactRecovered,
            recoveryReason: finalization.recoveryReason,
            exitCode: result.status,
            workerEvents,
            structuredResultWritten: finalization.structuredResultWritten,
            idleTimedOut: result.idleTimedOut,
            promptPath,
            eventsPath: jsonlPath,
            resultPath: fs.existsSync(lastMessagePath) ? lastMessagePath : undefined,
            skills: summarizeSkillBinding(skillBinding),
            skillBindingPath: skillBinding.bindingPath,
            skillPacketPath: skillBinding.packetPath,
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
      console.log(`  session: ${recoveredSessionId}`);
      console.log(`  prompt: ${promptPath}`);
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
      if (result.ok) {
        clearSupersededRecoveryEscalations({
          store,
          previousRun,
          newRunId: result.runId,
          actor: "recovery-agent",
          recoveryKind: "restart",
        });
      }
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

function clearSupersededRecoveryEscalations(input: {
  store: SwarmStore;
  previousRun: AgentRunRecord;
  newRunId: string;
  actor: string;
  recoveryKind: "restart" | "revive";
}): void {
  const entityType = input.previousRun.entityType ?? "slice";
  const entityId = input.previousRun.entityId ?? input.previousRun.sliceId;
  const runNeedle = input.previousRun.id.toLowerCase();
  const clearable = input.store.listEscalations("active").filter((escalation) => {
    if (escalation.entityType !== entityType || escalation.entityId !== entityId) return false;
    if (!["warning", "blocker", "human_required", "critical"].includes(escalation.level)) return false;
    const haystack = `${escalation.message ?? ""} ${escalation.reason ?? ""} ${escalation.createdBy ?? ""}`.toLowerCase();
    return haystack.includes(runNeedle) && /stale|recovery|reviv|restart/.test(haystack);
  });
  for (const escalation of clearable) {
    const reason = `Superseded by successful ${input.recoveryKind} run ${input.newRunId} for ${input.previousRun.id}.`;
    input.store.clearEscalation(escalation.id, { reason, clearedBy: input.actor });
    input.store.addEvent(
      createEvent({
        actor: input.actor,
        type: "escalation.cleared",
        entityType: "escalation",
        entityId: escalation.id,
        payload: {
          reason,
          previousRunId: input.previousRun.id,
          recoveryRunId: input.newRunId,
          recoveryKind: input.recoveryKind,
          clearedAfterRecovery: true,
        },
      }),
    );
  }
}

function sessionIdFromAgentRunEvents(run: AgentRunRecord): string | undefined {
  if (!run.eventsPath || !fs.existsSync(run.eventsPath)) return undefined;
  return extractSessionIdFromWorkerJsonl(fs.readFileSync(run.eventsPath, "utf8"));
}

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
  if (input.driver !== "fixture" && !getWorkerDriver(input.driver)) {
    throw new Error(`Invalid overseer driver: ${input.driver}. Expected one of: ${["fixture", ...workerDriverIds()].sort().join(", ")}.`);
  }
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
  const protocol = loadProtocol(input.workspace);
  const skillBinding = prepareSkillBindings({
    workspace: input.workspace,
    targetPath: input.workspace,
    artifactPath,
    runId,
    role: "overseer",
    protocol,
  });
  const prompt = buildOverseerPrompt({
    workspace: input.workspace,
    store: input.store,
    scenario: input.scenario,
    manifest,
    snapshot,
    execute: Boolean(input.execute),
    skillPacket: skillBinding.promptSection,
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
    eventsPath: jsonlPath,
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
        eventsPath: jsonlPath,
        skills: summarizeSkillBinding(skillBinding),
        skillBindingPath: skillBinding.bindingPath,
        skillPacketPath: skillBinding.packetPath,
      },
    }),
  );

  let overseerFinalization: WorkerFinalization;
  let result: {
    status: number | null;
    stdout?: string;
    stderr?: string;
    workerEvents?: ReturnType<typeof ingestWorkerJsonl>;
    idleTimedOut?: boolean;
  };
  if (input.driver === "fixture") {
    const decision = runFixtureOverseerDecision({ scenario: input.scenario, snapshot });
    fs.writeFileSync(resultPath, `${JSON.stringify(decision)}\n`, "utf8");
    result = {
      status: 0,
      stdout: `${JSON.stringify({ type: "fixture.overseer.completed", scenario: input.scenario, actor: input.actor })}\n`,
    };
    overseerFinalization = { ok: true, structuredResultWritten: true };
  } else {
    const adapter = getWorkerDriver(input.driver)!;
    const spec: WorkerRunSpec = {
      prompt: buildOverseerLaunchPrompt(promptPath, input.scenario),
      targetPath: input.workspace,
      schemaPath,
      resultPath,
      model: input.model,
      readOnly: true,
      resultSchema: overseerDecisionSchema,
      driverConfig: protocol.protocol.workers.drivers[input.driver] ?? {},
    };
    const invocation = adapter.buildInvocation(spec);
    result = await spawnWorkerStreaming({
      command: invocation.command,
      args: invocation.args,
      stdin: invocation.stdin,
      cwd: input.workspace,
      jsonlPath,
      actor: input.actor,
      sliceId: entityId,
      entityType: "harness",
      entityId,
      store: input.store,
      driver: input.driver,
      eventPrefix: "overseer",
      runId,
      classify: adapter.classifyHeartbeat?.bind(adapter),
      idleTimeoutMs: agentIdleTimeoutMsForProtocol(protocol),
    });
    overseerFinalization = adapter.finalize({ exitCode: result.status, stdout: result.stdout ?? "", spec });
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
  const runCompleted = overseerFinalization.ok && parsedDecision.ok;
  input.store.updateAgentRun(runId, {
    status: runCompleted ? "completed" : "failed",
    sessionId: overseerEvents.sessionId,
    eventsPath: jsonlPath,
    resultPath: fs.existsSync(resultPath) ? resultPath : undefined,
    stderrPath: result.stderr ? stderrPath : undefined,
  });
  const skillIsolationFindings = recordSkillIsolationWarning({
    store: input.store,
    actor: input.actor,
    runId,
    entityType: "harness",
    entityId,
    eventPrefix: "overseer",
    findings: overseerEvents.skillIsolationFindings,
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
      driver: input.driver,
      costUsd: overseerFinalization.costUsd,
      resultArtifactRecovered: overseerFinalization.resultArtifactRecovered,
      recoveryReason: overseerFinalization.recoveryReason,
      skillBinding,
      skillIsolationFindings,
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
          driver: input.driver,
          ok: overseerFinalization.ok,
          failureReason: overseerFinalization.failureReason,
          resultArtifactRecovered: overseerFinalization.resultArtifactRecovered,
          recoveryReason: overseerFinalization.recoveryReason,
          eventsPath: jsonlPath,
          resultPath,
          stderrPath: result.stderr ? stderrPath : undefined,
          skills: summarizeSkillBinding(skillBinding),
          skillBindingPath: skillBinding.bindingPath,
          skillPacketPath: skillBinding.packetPath,
          overseerEvents,
          skillIsolationFindings,
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
  const promptPath = path.join(artifactPath, `worker-prompt-${runId}.md`);
  const schemaPath = path.join(input.workspace, "schemas", "worker-result.schema.json");
  writeWorkerResultSchema(schemaPath);
  const skillBinding = prepareSkillBindings({
    workspace: input.workspace,
    targetPath: target.path,
    artifactPath,
    runId,
    role: "worker",
    protocol,
  });
  const repairContext = buildSliceRepairContext(input.store, slice);
  const prompt = buildWorkerPrompt({
    slice,
    targetPath: target.path,
    laneName: lane?.name,
    skillPacket: skillBinding.promptSection,
    repairContext,
  });
  fs.writeFileSync(promptPath, prompt, "utf8");
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
    eventsPath: jsonlPath,
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
        promptPath,
        eventsPath: jsonlPath,
        skills: summarizeSkillBinding(skillBinding),
        skillBindingPath: skillBinding.bindingPath,
        skillPacketPath: skillBinding.packetPath,
        verificationObligations: summarizeVerificationObligations(slice),
      },
    }),
  );

  let result: {
    status: number | null;
    stdout?: string;
    stderr?: string;
    workerEvents?: ReturnType<typeof ingestWorkerJsonl>;
    idleTimedOut?: boolean;
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
      stdin: invocation.stdin,
      cwd: target.path,
      jsonlPath,
      actor: input.actor,
      sliceId: slice.id,
      store: input.store,
      driver: driverId,
      runId,
      classify: adapter.classifyHeartbeat?.bind(adapter),
      idleTimeoutMs: agentIdleTimeoutMsForProtocol(protocol),
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
  const skillIsolationFindings = recordSkillIsolationWarning({
    store: input.store,
    actor: input.actor,
    runId,
    entityType: "slice",
    entityId: slice.id,
    eventPrefix: "worker",
    findings: workerEvents.skillIsolationFindings,
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
        resultArtifactRecovered: finalization.resultArtifactRecovered,
        recoveryReason: finalization.recoveryReason,
        idleTimedOut: result.idleTimedOut,
        runId,
        previousRunId: input.previousRunId,
        promptPath,
        eventsPath: jsonlPath,
        resultPath: lastMessagePath,
        stderrPath: result.stderr ? stderrPath : undefined,
        skills: summarizeSkillBinding(skillBinding),
        skillBindingPath: skillBinding.bindingPath,
        skillPacketPath: skillBinding.packetPath,
        workerEvents,
        skillIsolationFindings,
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
    promptPath,
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
  const promptPath = path.join(artifactPath, `review-prompt-${runId}.md`);
  const schemaPath = path.join(input.workspace, "schemas", "review-result.schema.json");
  writeReviewResultSchema(schemaPath);

  const evidence = input.store.listEvidence(slice.id);
  const sourceMutationsBefore = inspectSourceMutations(slice);
  const protocol = loadProtocol(target.path);
  const skillBinding = prepareSkillBindings({
    workspace: input.workspace,
    targetPath: target.path,
    artifactPath,
    runId,
    role: "reviewer",
    protocol,
  });
  const prompt = buildReviewPrompt({
    slice,
    targetPath: target.path,
    laneName: lane?.name,
    evidence,
    sourceMutations: sourceMutationsBefore,
    skillPacket: skillBinding.promptSection,
  });
  fs.writeFileSync(promptPath, prompt, "utf8");
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
    eventsPath: jsonlPath,
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
        promptPath,
        eventsPath: jsonlPath,
        skills: summarizeSkillBinding(skillBinding),
        skillBindingPath: skillBinding.bindingPath,
        skillPacketPath: skillBinding.packetPath,
        verificationObligations: summarizeVerificationObligations(slice),
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
    idleTimedOut?: boolean;
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
    const spec: WorkerRunSpec = {
      prompt,
      targetPath: target.path,
      schemaPath,
      resultPath,
      model: input.model,
      readOnly: false,
      resultSchema: reviewResultSchema,
      driverConfig: protocol.protocol.workers.drivers[input.driver] ?? {},
    };
    const invocation = adapter.buildInvocation(spec);
    result = await spawnWorkerStreaming({
      command: invocation.command,
      args: invocation.args,
      stdin: invocation.stdin,
      cwd: target.path,
      jsonlPath,
      actor: input.actor,
      sliceId: slice.id,
      store: input.store,
      driver: input.driver,
      eventPrefix: "reviewer",
      runId,
      classify: adapter.classifyHeartbeat?.bind(adapter),
      idleTimeoutMs: agentIdleTimeoutMsForProtocol(protocol),
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
  const skillIsolationFindings = recordSkillIsolationWarning({
    store: input.store,
    actor: input.actor,
    runId,
    entityType: "slice",
    entityId: slice.id,
    eventPrefix: "reviewer",
    findings: reviewerEvents.skillIsolationFindings,
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
          resultArtifactRecovered: reviewFinalization.resultArtifactRecovered,
          recoveryReason: reviewFinalization.recoveryReason,
          idleTimedOut: result.idleTimedOut,
          runId,
          promptPath,
          eventsPath: jsonlPath,
          resultPath,
          stderrPath: result.stderr ? stderrPath : undefined,
          skills: summarizeSkillBinding(skillBinding),
          skillBindingPath: skillBinding.bindingPath,
          skillPacketPath: skillBinding.packetPath,
          reviewerEvents,
          skillIsolationFindings,
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
          resultArtifactRecovered: reviewFinalization.resultArtifactRecovered,
          recoveryReason: reviewFinalization.recoveryReason,
          runId,
          promptPath,
          eventsPath: jsonlPath,
          resultPath,
          stderrPath: result.stderr ? stderrPath : undefined,
          skills: summarizeSkillBinding(skillBinding),
          skillBindingPath: skillBinding.bindingPath,
          skillPacketPath: skillBinding.packetPath,
          reviewerEvents,
          skillIsolationFindings,
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
    promptPath,
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
  stdin?: string;
  cwd: string;
  jsonlPath: string;
  actor: string;
  sliceId: string;
  entityType?: EntityType;
  entityId?: string;
  store: SwarmStore;
  driver: string;
  runId?: string;
  eventPrefix?: string;
  classify?: (event: Record<string, unknown>) => HeartbeatState | undefined;
  idleTimeoutMs?: number;
}): Promise<WorkerStreamingResult> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(input.jsonlPath), { recursive: true });
    fs.writeFileSync(input.jsonlPath, "", "utf8");
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const ingestor = createWorkerJsonlIngestor({
      store: input.store,
      runId: input.runId,
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
      windowsHide: true,
      stdio: [input.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let settled = false;
    let idleTimedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let forceResolveTimer: NodeJS.Timeout | undefined;
    const idleTimeoutMs = input.idleTimeoutMs ?? configuredAgentIdleTimeoutMs();
    const entityType = input.entityType ?? "slice";
    const entityId = input.entityId ?? input.sliceId;

    const clearTimers = () => {
      if (killTimer) clearTimeout(killTimer);
      if (forceResolveTimer) clearTimeout(forceResolveTimer);
    };

    const resolveOnce = (status: number | null, stderr: string) => {
      if (settled) return;
      settled = true;
      clearTimers();
      const workerEvents = ingestor.flush();
      resolve({
        status,
        stdout: stdoutChunks.join(""),
        stderr,
        workerEvents,
        idleTimedOut,
      });
    };

    const armIdleTimer = () => {
      if (!idleTimeoutMs || settled) return;
      if (killTimer) clearTimeout(killTimer);
      killTimer = setTimeout(() => {
        if (settled) return;
        idleTimedOut = true;
        const message = `Agent child process produced no output for ${Math.round(idleTimeoutMs / 1000)}s; terminating for supervised recovery.`;
        stderrChunks.push(message);
        input.store.upsertHeartbeat({
          id: `heartbeat:${input.actor}`,
          actor: input.actor,
          state: "blocked",
          detail: message,
          entityType,
          entityId,
        });
        input.store.addEvent(
          createEvent({
            actor: input.actor,
            type: `${input.eventPrefix ?? "worker"}.child_idle_timeout`,
            entityType,
            entityId,
            payload: {
              driver: input.driver,
              runId: input.runId,
              idleTimeoutMs,
              pid: child.pid,
              jsonlPath: input.jsonlPath,
            },
          }),
        );
        terminateChildProcessTree(child);
        forceResolveTimer = setTimeout(() => {
          resolveOnce(1, stderrChunks.join("\n"));
        }, 10000);
      }, idleTimeoutMs);
    };
    armIdleTimer();

    // Feed the prompt via stdin (workers/reviewers/overseer) so multi-line prompts
    // survive Windows .cmd shim arg forwarding; harmless when no stdin is provided.
    if (input.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.write(input.stdin);
      child.stdin.end();
    }

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      armIdleTimer();
      stdoutChunks.push(chunk);
      fs.appendFileSync(input.jsonlPath, chunk, "utf8");
      ingestor.ingest(chunk);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      armIdleTimer();
      stderrChunks.push(chunk);
    });
    child.on("error", (error) => {
      resolveOnce(1, [...stderrChunks, error instanceof Error ? error.message : String(error)].filter(Boolean).join("\n"));
    });
    child.on("close", (status) => {
      resolveOnce(status, stderrChunks.join(""));
    });
  });
}

function terminateChildProcessTree(child: ChildProcess): void {
  if (child.pid && process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  try {
    child.kill();
  } catch {
    // It may already be gone after taskkill.
  }
  child.unref();
}

function configuredAgentIdleTimeoutMs(): number | undefined {
  const raw = process.env.SWARM_AGENT_IDLE_TIMEOUT_SECONDS ?? process.env.SWARM_CHILD_IDLE_TIMEOUT_SECONDS;
  if (!raw) return undefined;
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return seconds * 1000;
}

function agentIdleTimeoutMsForProtocol(protocol: ReturnType<typeof loadProtocol>): number | undefined {
  const envOverride = configuredAgentIdleTimeoutMs();
  if (envOverride) return envOverride;
  const configured = protocol.protocol.recovery.childIdleTimeoutSeconds;
  if (typeof configured !== "number" || !Number.isFinite(configured) || configured <= 0) return undefined;
  return configured * 1000;
}

function printWorkerRunResult(result: WorkerRunResult): void {
  console.log(`Worker ${result.ok ? "completed" : "failed"} for ${result.sliceId}`);
  console.log(`  run: ${result.runId}`);
  console.log(`  prompt: ${result.promptPath}`);
  console.log(`  events: ${result.eventsPath}`);
  console.log(`  ingested events: ${result.workerEvents.eventCount}`);
  if (result.workerEvents.sessionId) console.log(`  session: ${result.workerEvents.sessionId}`);
  if (result.workerEvents.parseErrorCount > 0) console.log(`  event parse errors: ${result.workerEvents.parseErrorCount}`);
  console.log(`  result: ${result.resultPath}`);
  if (result.stderr?.trim()) console.error(result.stderr.trim());
}

function printReviewRunResult(result: ReviewRunResult): void {
  const reviewStatus = result.reviewResult?.status ?? "invalid";
  console.log(`Review ${result.reviewResult ? reviewStatus : "failed"} for ${result.sliceId}`);
  console.log(`  run: ${result.runId}`);
  console.log(`  prompt: ${result.promptPath}`);
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

function renderRunFocusPacket(packet: RunFocusPacket): string {
  const lines = [
    `Run Focus: ${packet.run.id}`,
    `Role: ${packet.run.role ?? "agent"} | Actor: ${packet.run.actor} | Status: ${packet.run.status} | Attempt: ${packet.run.attempt}`,
    packet.slice ? `Slice: ${packet.slice.id} - ${packet.slice.title} [${packet.slice.status}]` : "Slice: unknown",
    packet.target ? `Target: ${packet.target.name} (${packet.target.path})` : "Target: unknown",
    packet.heartbeat
      ? `Heartbeat: ${packet.heartbeat.state} age ${formatDuration(packet.heartbeat.ageMs ?? 0)}${packet.heartbeat.detail ? ` - ${packet.heartbeat.detail}` : ""}`
      : "Heartbeat: none",
    `Prompt: ${packet.artifacts.prompt.path ?? "missing"}${packet.artifacts.prompt.exists ? "" : " (missing)"}`,
    `Events: ${packet.artifacts.events.path ?? "missing"}${packet.eventStream.exists ? ` (${packet.eventStream.lineCount} lines)` : " (missing)"}`,
    `Result: ${packet.artifacts.result.path ?? "missing"}${packet.artifacts.result.exists ? "" : " (missing)"}`,
    `Failure classes: ${packet.diagnosis.failureClasses.join(", ") || "none"}`,
  ];
  if (packet.latestSignals.lastCommand) {
    lines.push(`Last command: ${packet.latestSignals.lastCommand.status ?? "unknown"} exit:${packet.latestSignals.lastCommand.exitCode ?? "-"} ${packet.latestSignals.lastCommand.command}`);
  }
  if (packet.latestSignals.lastAgentMessage?.message) {
    lines.push(`Last message: ${JSON.stringify(packet.latestSignals.lastAgentMessage.message).slice(0, 500)}`);
  }
  if (packet.activeEscalations.length > 0) {
    lines.push("Active escalations:");
    for (const escalation of packet.activeEscalations) lines.push(`  - ${escalation.level} ${escalation.entityType}:${escalation.entityId} ${escalation.message}`);
  }
  if (packet.diagnosis.recommendedInterventions.length > 0) {
    lines.push("Recommended interventions:");
    for (const item of packet.diagnosis.recommendedInterventions) lines.push(`  - ${item}`);
  }
  return lines.join("\n");
}

function renderSliceFocusPacket(packet: SliceFocusPacket): string {
  const lines = [
    `Slice Focus: ${packet.slice.id}`,
    `${packet.slice.title} [${packet.slice.status}]`,
    `FR/AC: ${packet.slice.frAcRefs.join(", ") || "none"}`,
    packet.lane ? `Lane: ${packet.lane.name}` : "Lane: unknown",
    packet.target ? `Target: ${packet.target.name} (${packet.target.path})` : "Target: unknown",
    `Runs: ${packet.runs.length} shown | Retry count: ${packet.diagnosis.retryCount}`,
    `Evidence: ${packet.evidence.length}`,
    `Active escalations: ${packet.activeEscalations.length}`,
  ];
  for (const run of packet.runs) {
    lines.push(`  - ${run.id} ${run.role ?? "agent"} ${run.actor} [${run.status}] attempt:${run.attempt}`);
  }
  if (packet.latestRunFocus) {
    lines.push("");
    lines.push("Latest Run:");
    lines.push(renderRunFocusPacket(packet.latestRunFocus));
  }
  if (packet.diagnosis.recommendedInterventions.length > 0) {
    lines.push("");
    lines.push("Slice interventions:");
    for (const item of packet.diagnosis.recommendedInterventions) lines.push(`  - ${item}`);
  }
  return lines.join("\n");
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

function maxAttempt(runs: Array<{ attempt?: number }>): number {
  return runs.reduce((highest, run) => Math.max(highest, run.attempt ?? 1), runs.length);
}

function summarizeRepairContextForPrompt(context: SliceRepairContext | undefined) {
  if (!context) return undefined;
  return {
    latestReview: context.review
      ? {
          evidenceId: context.review.evidenceId,
          status: context.review.status,
          requiredFixes: context.review.requiredFixes.slice(0, 8),
          nonPassingRefs: context.review.nonPassingRefs.slice(0, 12),
          recommendation: context.review.recommendation,
          createdAt: context.review.createdAt,
        }
      : undefined,
    humanFeedback: context.humanFeedback.slice(-6).map((item) => ({
      evidenceId: item.evidenceId,
      ref: item.ref,
      status: item.status,
      actor: item.actor,
      notes: item.notes,
      packetId: item.packetId,
      createdAt: item.createdAt,
    })),
    activeBlockers: context.activeEscalations.slice(-6),
  };
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

function buildLiveAgentResetArgs(options: LiveAgentSmokeResetOptions): string[] {
  const args: string[] = [];
  pushOption(args, "--workspace", options.workspace);
  pushOption(args, "--scenario", options.scenario);
  if (options.stopRelatedProcesses) args.push("--stop-related-processes");
  return args;
}

function buildLiveAgentRunArgs(mode: "acceptance-loop" | "full-product", options: LiveAgentSmokeRunOptions): string[] {
  const args = ["--mode", mode];
  if (options.reset) args.push("--reset");
  pushOption(args, "--workspace", options.workspace);
  pushOption(args, "--driver", options.driver);
  pushOption(args, "--scenario", options.scenario);
  if (mode === "acceptance-loop") pushOption(args, "--fault", options.fault);
  pushOption(args, "--max-turns", options.maxTurns);
  pushOption(args, "--max-runtime-seconds", options.maxRuntimeSeconds);
  pushOption(args, "--execute-limit", options.executeLimit);
  pushOption(args, "--max-slices", options.maxSlices);
  pushOption(args, "--max-agent-runs", options.maxAgentRuns);
  pushOption(args, "--max-repair-attempts", options.maxRepairAttempts);
  pushOption(args, "--summary", options.summary);
  pushOption(args, "--artifacts", options.artifacts);
  pushOption(args, "--history-root", options.historyRoot);
  pushOption(args, "--run-id", options.runId);
  if (options.history === false) args.push("--history", "false");
  return args;
}

function buildLiveAgentFakeArgs(options: LiveAgentSmokeFakeOptions): string[] {
  const args: string[] = [];
  if (options.reset) args.push("--reset");
  pushOption(args, "--workspace", options.workspace);
  pushOption(args, "--scenario", options.scenario);
  pushOption(args, "--summary", options.summary);
  pushOption(args, "--artifacts", options.artifacts);
  return args;
}

function pushOption(args: string[], flag: string, value: string | number | undefined): void {
  if (value === undefined) return;
  args.push(flag, String(value));
}

function runRepoScript(scriptRelativePath: string, args: string[]): void {
  const scriptPath = path.join(cliRepoRoot, scriptRelativePath);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: cliRepoRoot,
    stdio: "inherit",
    env: process.env,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.signal) {
    console.error(`Smoke script terminated by signal ${result.signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = result.status ?? 1;
}

function liveAgentRunScriptFor(scenario: string | undefined): string {
  return scenario === "live-agent-smoke-h2"
    ? "scripts/run-support-triage-live-demo.mjs"
    : "scripts/run-live-agent-demo.mjs";
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
    qualityGate: {
      status: sourceMutationDetected ? "failed" : "passed",
      summary: sourceMutationDetected
        ? "Source mutation prevents a trustworthy real-world review."
        : "Fixture review found no structured quality risks in recorded harness evidence.",
      dimensions: [
        {
          dimension: "runtime_path",
          status: sourceMutationDetected ? "failed" : "passed",
          risk: sourceMutationDetected ? "high" : "none",
          evidence: evidenceIds,
          finding: sourceMutationDetected
            ? "Runtime behavior cannot be trusted while immutable source specs are mutated."
            : "Fixture review relies on existing worker and command evidence for runtime path proof.",
        },
        {
          dimension: "stub_or_hardcode",
          status: "passed",
          risk: "none",
          evidence: evidenceIds,
          finding: "No fixture-level stub or hardcode concern was raised by recorded evidence.",
        },
        {
          dimension: "test_meaningfulness",
          status: sourceMutationDetected ? "failed" : "passed",
          risk: sourceMutationDetected ? "high" : "none",
          evidence: evidenceIds,
          finding: sourceMutationDetected
            ? "Tests cannot be trusted against mutated immutable source inputs."
            : "Recorded command/worker evidence is sufficient for the fixture review path.",
        },
        {
          dimension: "error_handling",
          status: "not_applicable",
          risk: "none",
          evidence: [],
          finding: "No additional fixture-only error-handling concern.",
        },
        {
          dimension: "integration_fit",
          status: sourceMutationDetected ? "failed" : "passed",
          risk: sourceMutationDetected ? "high" : "none",
          evidence: evidenceIds,
          finding: sourceMutationDetected
            ? "Integration fit cannot be confirmed after source mutation."
            : "Recorded evidence is coherent with the slice scope.",
        },
        {
          dimension: "maintainability",
          status: "not_applicable",
          risk: "none",
          evidence: [],
          finding: "No additional fixture-only maintainability concern.",
        },
        {
          dimension: "real_world_readiness",
          status: sourceMutationDetected ? "failed" : "passed",
          risk: sourceMutationDetected ? "high" : "none",
          evidence: evidenceIds,
          finding: sourceMutationDetected
            ? "A mutated source spec blocks readiness."
            : "No fixture-level readiness concern was raised.",
        },
      ],
      blockingConcerns: sourceMutationDetected ? ["Immutable source mutation detected during review."] : [],
      residualRisks: [],
    },
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
  skillPacket?: string;
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
  const safeDirectoryPath = formatGitSafeDirectoryPath(input.targetPath);
  return `You are an independent reviewer inside the Agent Swarm MVP harness.

You are reviewing implementation work for a slice. Use the tools and commands normally available under the project protocol to inspect the implementation, run targeted checks, and gather evidence.
Your role is independent review, not repair: do not change implementation code unless the protocol explicitly asks you to perform reviewer-side repair. Never edit source specs.
Judge whether the work genuinely satisfies the immutable FR/AC refs.

Target workspace:
${input.targetPath}

Lane:
${input.laneName ?? input.slice.laneId}

${input.skillPacket ? `${input.skillPacket}\n` : ""}
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

Verification obligations (read-only):
${formatVerificationObligations(input.slice)}

Scope:
${input.slice.scope.map((item) => `- ${item}`).join("\n")}

Out of scope:
${input.slice.outOfScope.map((item) => `- ${item}`).join("\n")}

Expected evidence:
${input.slice.expectedEvidence.map((item) => `- ${item}`).join("\n")}

Verification requirements:
${input.slice.verificationRequirements.map((item) => `- ${item}`).join("\n")}

Sleuth Review Gate:
- In addition to FR/AC matching, judge whether this implementation is fit for real use inside the target project.
- Return a structured qualityGate with exactly these dimensions: runtime_path, stub_or_hardcode, test_meaningfulness, error_handling, integration_fit, maintainability, real_world_readiness.
- For each dimension, provide status passed|warning|failed|not_applicable, risk none|low|medium|high, concrete evidence, and a finding.
- Mark the qualityGate failed when any dimension has a material behavior gap, high risk, fake-only/stubbed behavior, hollow tests, unproven runtime path, unsafe integration, or real-world readiness blocker.
- Medium risks may remain warnings only when they are genuinely non-blocking and residualRisks explains why.
- Put any acceptance-blocking quality concern in blockingConcerns and use blocked or repair_required rather than accepted.
- The deterministic verifier will block acceptance when the qualityGate fails, has blockingConcerns, or contains high-risk/failed dimensions.

Recorded harness evidence:
${evidenceLines}

Latest worker result snippet:
${latestWorker?.ref ? readArtifactSnippet(latestWorker.ref) : "No worker result artifact recorded."}

Latest command evidence:
${latestCommand ? JSON.stringify(latestCommand.payload, null, 2).slice(0, 4000) : "No command evidence recorded yet."}

Source hash status:
${JSON.stringify(input.sourceMutations, null, 2)}

Review rules:
- Do not modify source specs.
- Do not create, edit, weaken, or reinterpret verification obligations.
- Prefer evidence from code inspection, targeted commands, recorded worker evidence, and recorded deterministic command evidence.
- If Git reports dubious ownership, prefer per-command safe-directory usage such as git -c safe.directory=${safeDirectoryPath} status --short; use the normalized forward-slash path and do not mutate global Git config.
- Do not reinterpret or rewrite the source spec.
- Treat missing per-FR/AC evidence as a finding.
- Judge evidence against the read-only verification obligations, not generic confidence or broad command success.
- Treat stubs, hardcoded shortcuts, hollow tests, or unproven runtime paths as material risks.
- Treat the Sleuth Review Gate as a first-class acceptance gate, not commentary.
- Deterministic command verification is a separate harness gate after reviewer acceptance.
- You may run npm test, node --test, git, shell, or other local inspection commands when useful and allowed by the configured driver/protocol.
- If command execution is unavailable or a command fails for policy/environment reasons, record that limitation in testAssessment and judge the implementation using code inspection, source refs, worker result evidence, and recorded command evidence.
- Use blocked only when evidence is missing or contradictory, code inspection shows a material behavior gap, source mutation is detected, or the implementation cannot be inspected safely.
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
  const qualityBlockingReasons = reviewQualityBlockingReasons(input.result);
  const effectiveStatus = sourceMutationDetected
    ? "human_required"
    : input.result.status === "repair_required" || input.result.status === "human_required"
      ? input.result.status
      : qualityBlockingReasons.length > 0
        ? "blocked"
        : input.result.status;

  for (const escalation of input.result.escalations) {
    insertReviewEscalation(input.store, input.slice, input.actor, escalation.level, escalation.message, input.result.summary);
  }
  if (qualityBlockingReasons.length > 0) {
    insertReviewEscalation(
      input.store,
      input.slice,
      input.actor,
      "blocker",
      "Sleuth Review Gate blocked acceptance.",
      qualityBlockingReasons.join("; "),
    );
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
    clearResolvedReviewEscalations(input.store, input.slice, input.actor, input.reviewEvidenceId);
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

function clearResolvedReviewEscalations(store: SwarmStore, slice: SliceRecord, actor: string, reviewEvidenceId: string): void {
  const activeEscalations = store.listEscalations("active");
  const clearable = activeEscalations.filter((escalation) => {
    if (escalation.entityType !== "slice" || escalation.entityId !== slice.id) return false;
    if (escalation.level !== "warning" && escalation.level !== "blocker") return false;
    return isReviewRepairEscalation(escalation);
  });
  for (const escalation of clearable) {
    const reason = "Latest independent review accepted the repaired slice.";
    store.clearEscalation(escalation.id, { reason, clearedBy: actor });
    store.addEvent(
      createEvent({
        actor,
        type: "escalation.cleared",
        entityType: "escalation",
        entityId: escalation.id,
        payload: {
          reason,
          sliceId: slice.id,
          reviewEvidenceId,
          clearedAfterReviewAccepted: true,
        },
      }),
    );
  }
}

function isReviewRepairEscalation(escalation: EscalationRecord): boolean {
  const haystack = `${escalation.message ?? ""} ${escalation.reason ?? ""} ${escalation.createdBy ?? ""}`.toLowerCase();
  if (/skill[_ -]isolation|user[- ]global skill|global .*skill/.test(haystack)) return false;
  return /review|reviewer|sleuth|repair|quality gate/.test(haystack);
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

function recordSkillIsolationWarning(input: {
  store: SwarmStore;
  actor: string;
  runId: string;
  entityType: EntityType;
  entityId: string;
  eventPrefix: string;
  findings: SkillIsolationFinding[];
}): SkillIsolationFinding[] {
  const findings = dedupeSkillIsolationFindings(input.findings);
  if (findings.length === 0) return [];
  const message = "Agent referenced user-global Codex skills outside harness-managed skill packet.";
  const activeExists = input.store
    .listEscalations("active")
    .some((item) => item.entityType === "agent_run" && item.entityId === input.runId && item.message === message);
  let escalationId: string | undefined;
  if (!activeExists) {
    const now = new Date().toISOString();
    escalationId = makeId("escalation");
    input.store.insertEscalation({
      id: escalationId,
      level: "warning",
      status: "active",
      entityType: "agent_run",
      entityId: input.runId,
      message,
      reason: findings.map((finding) => finding.path).join("; ").slice(0, 1000),
      createdBy: input.actor,
      createdAt: now,
      updatedAt: now,
    });
  }
  input.store.addEvent(
    createEvent({
      actor: input.actor,
      type: `${input.eventPrefix}.skill_isolation_warning`,
      entityType: input.entityType,
      entityId: input.entityId,
      payload: {
        runId: input.runId,
        escalationId,
        findings,
        activeEscalationAlreadyExisted: activeExists,
        message,
      },
    }),
  );
  return findings;
}

function dedupeSkillIsolationFindings(findings: SkillIsolationFinding[]): SkillIsolationFinding[] {
  const seen = new Set<string>();
  const result: SkillIsolationFinding[] = [];
  for (const finding of findings) {
    const key = `${finding.kind}:${finding.path.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(finding);
  }
  return result;
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
  const nonPassingRefs = slice.frAcRefs.filter((ref) => reviewFindingForRef(parsed.data.frAcFindings, ref)?.status !== "passed");
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
  const qualityBlockingReasons = reviewQualityBlockingReasons(parsed.data);
  if (qualityBlockingReasons.length > 0) {
    return {
      passed: false,
      reason: `latest review quality gate failed: ${qualityBlockingReasons.join("; ")}`,
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

function buildSliceRepairContext(store: SwarmStore, slice: SliceRecord): SliceRepairContext | undefined {
  const review = latestRepairReviewContext(store, slice);
  const humanFeedback = latestHumanRepairFeedback(store, slice);
  const activeEscalations = store
    .listEscalations("active")
    .filter((item) => item.entityType === "slice" && item.entityId === slice.id && ["blocker", "human_required", "critical"].includes(item.level))
    .slice(-6)
    .map((item) => ({
      id: item.id,
      level: item.level,
      message: item.message,
      reason: item.reason,
    }));

  if (!review && humanFeedback.length === 0 && activeEscalations.length === 0) return undefined;
  return { review, humanFeedback, activeEscalations };
}

function latestRepairReviewContext(store: SwarmStore, slice: SliceRecord): SliceRepairContext["review"] | undefined {
  const reviewEvidence = store
    .listEvidence(slice.id)
    .filter((item) => item.kind === "review_result" && item.payload.reviewResult)
    .at(-1);
  if (!reviewEvidence) return undefined;
  const parsed = reviewResultSchema.safeParse(reviewEvidence.payload.reviewResult);
  if (!parsed.success) return undefined;
  if (parsed.data.status === "accepted" && reviewQualityBlockingReasons(parsed.data).length === 0) return undefined;
  return {
    evidenceId: reviewEvidence.id,
    status: parsed.data.status,
    summary: parsed.data.summary,
    recommendation: parsed.data.recommendation,
    requiredFixes: parsed.data.requiredFixes,
    nonPassingRefs: parsed.data.frAcFindings.filter((finding) => finding.status !== "passed").map((finding) => finding.ref),
    createdAt: reviewEvidence.createdAt,
  };
}

function latestHumanRepairFeedback(store: SwarmStore, slice: SliceRecord): SliceRepairContext["humanFeedback"] {
  return store
    .listEvidence(slice.id)
    .filter((item) => item.kind === "artifact" && item.payload.type === "human_verification_result")
    .filter((item) => {
      const status = stringValue(item.payload.status);
      return status === "failed" || status === "needs_rework";
    })
    .slice(-8)
    .map((item) => ({
      evidenceId: item.id,
      ref: item.ref,
      status: stringValue(item.payload.status),
      actor: stringValue(item.payload.actor),
      notes: stringValue(item.payload.notes),
      packetId: stringValue(item.payload.packetId),
      createdAt: item.createdAt,
    }));
}

function reviewFindingForRef(findings: ReviewResult["frAcFindings"], ref: string): ReviewResult["frAcFindings"][number] | undefined {
  const exact = findings.find((item) => item.ref === ref);
  if (exact) return exact;
  return findings.find((item) => item.ref.startsWith(`${ref}.`));
}

function reviewQualityBlockingReasons(result: ReviewResult): string[] {
  const gate = result.qualityGate;
  const reasons: string[] = [];
  if (gate.status === "failed") reasons.push(`qualityGate.status=${gate.status}`);
  for (const concern of gate.blockingConcerns) {
    if (concern.trim()) reasons.push(concern.trim());
  }
  for (const dimension of gate.dimensions) {
    if (dimension.status === "failed" || dimension.risk === "high") {
      reasons.push(`${dimension.dimension} ${dimension.status}/${dimension.risk}: ${dimension.finding}`);
    }
  }
  return reasons;
}

function validateSliceDispatchContract(slice: SliceRecord): void {
  const missing: string[] = [];
  if (slice.frAcRefs.length === 0) missing.push("frAcRefs");
  if (!slice.deliveryQuestion.trim()) missing.push("deliveryQuestion");
  if (slice.expectedEvidence.length === 0) missing.push("expectedEvidence");
  const obligationIssues = validateVerificationObligations(slice);
  if (obligationIssues.length > 0) missing.push(`verificationObligations (${obligationIssues.join("; ")})`);
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

function validateVerificationObligations(slice: SliceRecord): string[] {
  if (slice.frAcRefs.length === 0) return [];
  const issues: string[] = [];
  if (slice.verificationObligations.length === 0) {
    issues.push("no obligations recorded");
    return issues;
  }
  const obligationRefs = new Set(slice.verificationObligations.map((obligation) => obligation.ref));
  const missingRefs = slice.frAcRefs.filter((ref) => !obligationRefs.has(ref));
  if (missingRefs.length > 0) issues.push(`missing refs: ${missingRefs.join(", ")}`);
  const extraRefs = slice.verificationObligations.map((obligation) => obligation.ref).filter((ref) => !slice.frAcRefs.includes(ref));
  if (extraRefs.length > 0) issues.push(`out-of-scope refs: ${extraRefs.join(", ")}`);
  for (const obligation of slice.verificationObligations) {
    if (!obligation.ref.trim()) issues.push("obligation has empty ref");
    if (!obligation.sourceText.trim()) issues.push(`${obligation.ref} missing sourceText`);
    if (!obligation.responsibleParty.trim()) issues.push(`${obligation.ref} missing responsibleParty`);
    if (obligation.immutable !== true) issues.push(`${obligation.ref} is not immutable`);
    if (!Array.isArray(obligation.criteria) || obligation.criteria.length === 0) {
      issues.push(`${obligation.ref} has no criteria`);
      continue;
    }
    for (const criterion of obligation.criteria) {
      if (!criterion.id.trim()) issues.push(`${obligation.ref} has criterion without id`);
      if (!criterion.expectedOutcome.trim()) issues.push(`${obligation.ref}/${criterion.id} missing expectedOutcome`);
      if (!criterion.acceptanceThreshold.trim()) issues.push(`${obligation.ref}/${criterion.id} missing acceptanceThreshold`);
      if (!Array.isArray(criterion.evidenceRequired) || criterion.evidenceRequired.length === 0) {
        issues.push(`${obligation.ref}/${criterion.id} missing evidenceRequired`);
      }
    }
  }
  return issues;
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
  return slice.frAcRefs.map((ref) =>
    attachCriterionResults(slice, {
      ref,
      status: "missing_evidence",
      evidenceIds: [],
      proof,
      verifiedBy: verifier,
    }),
  );
}

function buildFrAcResults(input: {
  slice: SliceRecord;
  verifier: string;
  commandPassed: boolean;
  reviewGate: ReturnType<typeof readLatestReviewGate>;
  workerGate: ReturnType<typeof readAndValidateWorkerResult>;
  verificationEvidenceId: string;
}): FrAcVerificationResult[] {
  return input.slice.frAcRefs.map((ref) => {
    const workerResult = input.workerGate.frAcResults.find((item) => item.ref === ref);
    if (!workerResult) {
      return attachCriterionResults(input.slice, {
        ref,
        status: "missing_evidence",
        evidenceIds: [input.verificationEvidenceId],
        proof: "No worker coverage result was available for this ref.",
        verifiedBy: input.verifier,
      });
    }
    if (workerResult.status !== "passed") {
      return attachCriterionResults(input.slice, {
        ...workerResult,
        evidenceIds: [...workerResult.evidenceIds, input.verificationEvidenceId],
        verifiedBy: input.verifier,
      });
    }
    if (!input.commandPassed) {
      return attachCriterionResults(input.slice, {
        ref,
        status: "failed",
        evidenceIds: [...workerResult.evidenceIds, input.verificationEvidenceId],
        proof: "Worker coverage existed, but the configured verification command failed.",
        verifiedBy: input.verifier,
      });
    }
    if (input.reviewGate.passed && requiresHumanVerification(input.slice, ref)) {
      return attachCriterionResults(input.slice, {
        ref,
        status: "awaiting_human_verification",
        evidenceIds: [...workerResult.evidenceIds, input.verificationEvidenceId],
        proof: `Automated verification passed, but ${ref} requires human verification before acceptance.\n\nSupporting proof: ${workerResult.proof}`,
        verifiedBy: input.verifier,
      });
    }
    return attachCriterionResults(input.slice, {
      ...workerResult,
      evidenceIds: [...workerResult.evidenceIds, input.verificationEvidenceId],
      verifiedBy: input.verifier,
    });
  });
}

type HumanVerificationPacketRecord = {
  ref: string;
  evidenceId: string;
  packetId: string;
  markdownPath: string;
  jsonPath: string;
  status: "awaiting_human_verification";
  generatedAt: string;
};

type HumanVerificationPacketData = {
  packetId: string;
  generatedAt: string;
  status: "awaiting_human_verification";
  ref: string;
  slice: {
    id: string;
    title: string;
    status: SliceRecord["status"];
    deliveryQuestion: string;
    scope: string[];
    outOfScope: string[];
  };
  target: { id: string; name: string; path: string };
  obligation?: SliceRecord["verificationObligations"][number];
  expectedOutcomes: string[];
  evidenceRequired: string[];
  automatedEvidence: {
    verificationEvidenceId: string;
    command: string;
    commandPassed: boolean;
    workerGate: ReturnType<typeof readAndValidateWorkerResult>;
    reviewGate: ReturnType<typeof readLatestReviewGate>;
    frAcResult?: FrAcVerificationResult;
  };
  humanInstructions: string[];
  decisionOptions: string[];
};

function requiresHumanVerification(slice: SliceRecord, ref: string): boolean {
  return slice.verificationObligations.some((obligation) => obligation.ref === ref && obligation.mode === "human_verification_required");
}

function attachHumanVerificationPacketEvidence(
  results: FrAcVerificationResult[],
  packets: HumanVerificationPacketRecord[],
): FrAcVerificationResult[] {
  const packetByRef = new Map(packets.map((packet) => [packet.ref, packet]));
  return results.map((result) => {
    const packet = packetByRef.get(result.ref);
    if (!packet) return result;
    return {
      ...result,
      evidenceIds: [...new Set([...result.evidenceIds, packet.evidenceId])],
      criteriaResults: result.criteriaResults?.map((criterion) => ({
        ...criterion,
        evidenceIds: [...new Set([...criterion.evidenceIds, packet.evidenceId])],
      })),
    };
  });
}

function writeHumanVerificationPackets(input: {
  workspace: string;
  store: SwarmStore;
  slice: SliceRecord;
  target: { id: string; name: string; path: string };
  verifier: string;
  command: string;
  commandPassed: boolean;
  workerGate: ReturnType<typeof readAndValidateWorkerResult>;
  reviewGate: ReturnType<typeof readLatestReviewGate>;
  verificationEvidenceId: string;
  frAcResults: FrAcVerificationResult[];
}): HumanVerificationPacketRecord[] {
  const refs = input.frAcResults.filter((result) => result.status === "awaiting_human_verification").map((result) => result.ref);
  if (refs.length === 0) return [];
  const artifactPath = path.join(artifactsDir(input.workspace), input.slice.id);
  fs.mkdirSync(artifactPath, { recursive: true });
  const generatedAt = new Date().toISOString();
  const records: HumanVerificationPacketRecord[] = [];
  for (const ref of refs) {
    const evidenceId = makeId("evidence");
    const packetId = `HVP-${evidenceId.slice(4)}`;
    const segment = sanitizeArtifactSegment(ref);
    const jsonPath = path.join(artifactPath, `human-verification-${segment}-${packetId}.json`);
    const markdownPath = path.join(artifactPath, `human-verification-${segment}-${packetId}.md`);
    const result = input.frAcResults.find((item) => item.ref === ref);
    const obligation = input.slice.verificationObligations.find((item) => item.ref === ref);
    const packet: HumanVerificationPacketData = {
      packetId,
      generatedAt,
      status: "awaiting_human_verification",
      ref,
      slice: {
        id: input.slice.id,
        title: input.slice.title,
        status: input.slice.status,
        deliveryQuestion: input.slice.deliveryQuestion,
        scope: input.slice.scope,
        outOfScope: input.slice.outOfScope,
      },
      target: {
        id: input.target.id,
        name: input.target.name,
        path: input.target.path,
      },
      obligation,
      expectedOutcomes: obligation?.criteria.map((criterion) => criterion.expectedOutcome) ?? [],
      evidenceRequired: obligation?.criteria.flatMap((criterion) => criterion.evidenceRequired) ?? [],
      automatedEvidence: {
        verificationEvidenceId: input.verificationEvidenceId,
        command: input.command,
        commandPassed: input.commandPassed,
        workerGate: input.workerGate,
        reviewGate: input.reviewGate,
        frAcResult: result,
      },
      humanInstructions: [
        "Review the immutable source text and expected outcomes.",
        "Run or open the target using the commands and paths in this packet.",
        "Compare actual behavior against every expected outcome.",
        "Record pass, fail, or needs-rework through the human verification workflow when available.",
      ],
      decisionOptions: ["human_verified", "failed", "needs_rework"],
    };
    fs.writeFileSync(jsonPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
    fs.writeFileSync(markdownPath, renderHumanVerificationPacketMarkdown(packet), "utf8");
    input.store.insertEvidence({
      id: evidenceId,
      sliceId: input.slice.id,
      kind: "artifact",
      ref,
      summary: `Human verification packet ready for ${ref}`,
      payload: {
        type: "human_verification_packet",
        packetId,
        ref,
        status: "awaiting_human_verification",
        markdownPath,
        jsonPath,
        generatedAt,
      },
      createdAt: generatedAt,
    });
    input.store.addEvent(
      createEvent({
        actor: input.verifier,
        type: "human_verification.packet_created",
        entityType: "slice",
        entityId: input.slice.id,
        payload: { packetId, ref, evidenceId, markdownPath, jsonPath },
      }),
    );
    records.push({ ref, evidenceId, packetId, markdownPath, jsonPath, status: "awaiting_human_verification", generatedAt });
  }
  return records;
}

function renderHumanVerificationPacketMarkdown(packet: HumanVerificationPacketData): string {
  const criteria = packet.obligation?.criteria ?? [];
  return [
    `# Human Verification Packet: ${packet.ref}`,
    "",
    `Packet: ${packet.packetId}`,
    `Generated: ${packet.generatedAt}`,
    `Status: ${packet.status}`,
    "",
    "## Requirement",
    "",
    `Source: ${packet.obligation?.sourceTitle ?? packet.obligation?.sourceUri ?? "unknown"}`,
    `Mode: ${packet.obligation?.mode ?? "human_verification_required"}`,
    `Responsible party: ${packet.obligation?.responsibleParty ?? "human"}`,
    "",
    "### Source Text",
    "",
    packet.obligation?.sourceText ?? packet.ref,
    packet.obligation?.sourceContext ? `\n### Source Context\n\n${packet.obligation.sourceContext}` : "",
    "",
    "## Slice And Target",
    "",
    `Slice: ${packet.slice.id} - ${packet.slice.title}`,
    `Delivery question: ${packet.slice.deliveryQuestion}`,
    `Target: ${packet.target.name}`,
    `Target path: ${packet.target.path}`,
    "",
    "Scope:",
    ...markdownList(packet.slice.scope),
    "",
    "Out of scope:",
    ...markdownList(packet.slice.outOfScope),
    "",
    "## Expected Outcomes",
    "",
    ...criteria.flatMap((criterion) => [
      `- ${criterion.id}: ${criterion.expectedOutcome}`,
      `  evidence required: ${criterion.evidenceRequired.join(", ")}`,
      `  threshold: ${criterion.acceptanceThreshold}`,
    ]),
    "",
    "## Automated Support Evidence",
    "",
    `Verification evidence: ${packet.automatedEvidence.verificationEvidenceId}`,
    `Command: ${packet.automatedEvidence.command}`,
    `Command passed: ${packet.automatedEvidence.commandPassed}`,
    `Worker gate: ${packet.automatedEvidence.workerGate.passed ? "passed" : "failed"} - ${packet.automatedEvidence.workerGate.reason}`,
    `Review gate: ${packet.automatedEvidence.reviewGate.passed ? "passed" : "failed"} - ${packet.automatedEvidence.reviewGate.reason}`,
    `FR/AC result: ${packet.automatedEvidence.frAcResult?.status ?? "unknown"}`,
    "",
    packet.automatedEvidence.frAcResult?.proof ?? "",
    "",
    "## Human Instructions",
    "",
    ...packet.humanInstructions.map((item) => `- ${item}`),
    "",
    "## Decision Options",
    "",
    ...packet.decisionOptions.map((item) => `- ${item}`),
    "",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function markdownList(items: string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ["- none"];
}

function attachCriterionResults(slice: SliceRecord, result: FrAcVerificationResult): FrAcVerificationResult {
  const obligation = slice.verificationObligations.find((item) => item.ref === result.ref);
  if (!obligation || obligation.criteria.length === 0) return result;
  return {
    ...result,
    criteriaResults: obligation.criteria.map((criterion) => ({
      criterionId: criterion.id,
      status: result.status,
      expectedOutcome: criterion.expectedOutcome,
      actualOutcome: result.proof,
      evidenceIds: result.evidenceIds,
    })),
  };
}

function formatVerificationObligations(slice: SliceRecord): string {
  if (slice.verificationObligations.length === 0) return "- none recorded";
  return slice.verificationObligations
    .map((obligation) => {
      const criteria = obligation.criteria
        .map(
          (criterion) =>
            `  - ${criterion.id}: ${criterion.expectedOutcome}\n    evidence: ${criterion.evidenceRequired.join(", ")}\n    threshold: ${criterion.acceptanceThreshold}`,
        )
        .join("\n");
      return [
        `- ${obligation.ref} [${obligation.mode}; ${obligation.responsibleParty}; immutable:${obligation.immutable}]`,
        `  source: ${obligation.sourceTitle ?? obligation.sourceUri ?? obligation.sourceRef ?? "unknown"}`,
        obligation.sourceContext ? `  context: ${obligation.sourceContext}` : undefined,
        `  source text: ${obligation.sourceText}`,
        `  criteria:`,
        criteria,
        obligation.guidance.length > 0 ? `  guidance: ${obligation.guidance.join(" | ")}` : undefined,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");
}

function summarizeVerificationObligations(slice: SliceRecord): Record<string, unknown>[] {
  return slice.verificationObligations.map((obligation) => ({
    ref: obligation.ref,
    mode: obligation.mode,
    responsibleParty: obligation.responsibleParty,
    criteriaCount: obligation.criteria.length,
    immutable: obligation.immutable,
  }));
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function scenarioEntityId(scenario: string): string {
  return `scenario:${scenario}`;
}

function loadScenarioManifest(workspace: string, scenario: string): ScenarioManifestLoad {
  const primaryPath = path.join(workspace, `${scenario}.json`);
  const fallbackPath = path.join(workspace, "live-agent-smoke.json");
  const manifestPath = fs.existsSync(primaryPath)
    ? primaryPath
    : fs.existsSync(fallbackPath)
      ? fallbackPath
      : primaryPath;
  if (!fs.existsSync(manifestPath)) {
    return {
      path: primaryPath,
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
  const data = parsed as Record<string, unknown>;
  const loadedScenario = typeof data.scenarioId === "string" ? data.scenarioId : undefined;
  if (manifestPath === fallbackPath && loadedScenario && loadedScenario !== scenario) {
    return {
      path: primaryPath,
      exists: false,
      data: {
        scenarioId: scenario,
        missing: true,
        note: `Fallback manifest ${fallbackPath} belongs to ${loadedScenario}, not ${scenario}.`,
      },
    };
  }
  return { path: manifestPath, exists: true, data };
}

function buildOverseerStatePacket(input: {
  workspace: string;
  store: SwarmStore;
  scenario: string;
  snapshot: ReturnType<typeof buildObservabilitySnapshot>;
  execute: boolean;
}) {
  const targetById = new Map(input.snapshot.targets.map((target) => [target.id, target]));
  const laneById = new Map(input.snapshot.lanes.map((lane) => [lane.id, lane]));
  const sourceByUri = new Map(input.snapshot.sources.map((source) => [source.uri, source]));
  const cli = `node "${process.argv[1]}"`;
  const sourcePullQueues = buildOverseerSourcePullQueues(input.snapshot, cli);
  const summarizedSlices = input.snapshot.slices.map((slice) => {
    const target = targetById.get(slice.targetId);
    const lane = laneById.get(slice.laneId);
    const evidenceKinds = [...new Set(slice.evidence.map((evidence) => evidence.kind))];
    const sourceDomains = [
      ...new Set(
        slice.sourceRefs
          .map((sourceRef) => sourceByUri.get(sourceRef.uri))
          .filter((source): source is SourceRecord => Boolean(source))
          .map((source) => sourceDomain(source)),
      ),
    ];
    const isFrontend = isFrontendTargetOrSlice(target, slice, sourceDomains);
    const workerActor = isFrontend ? "dashboard-worker" : "backend-worker";
    const reviewerActor = isFrontend ? "dashboard-reviewer" : "backend-reviewer";
    const repairContext = buildSliceRepairContext(input.store, slice);
    const retryCount = maxAttempt(slice.agentRuns);
    let nextCommand: string | undefined;
    let nextCommandPurpose: string | undefined;
    if (["ready", "blocked", "repairing"].includes(slice.status)) {
      nextCommand = `${cli} run ${slice.id} --actor ${workerActor} --driver codex`;
      nextCommandPurpose = slice.status === "repairing" && repairContext
        ? "Dispatch a targeted repair worker using the stored review/human repair context."
        : "Dispatch the worker for the active slice selected by the harness.";
    } else if (["implemented", "ready_for_review"].includes(slice.status)) {
      nextCommand = `${cli} review ${slice.id} --actor ${reviewerActor} --driver codex`;
      nextCommandPurpose = "Dispatch independent review for worker evidence already recorded on the slice.";
    }
    return {
      id: slice.id,
      title: slice.title,
      status: slice.status,
      targetId: slice.targetId,
      targetName: target?.name,
      laneId: slice.laneId,
      laneName: lane?.name,
      sourceDomains,
      frAcRefs: slice.frAcRefs,
      leases: slice.leases.map((lease) => ({ ref: lease.frAcRef, status: lease.status })),
      evidenceKinds,
      hasWorkerEvidence: evidenceKinds.includes("worker_result"),
      hasReviewEvidence: evidenceKinds.includes("review_result"),
      hasCommandEvidence: evidenceKinds.includes("command"),
      reviewStatus: slice.reviewResult?.status,
      retryCount,
      repairContext: summarizeRepairContextForPrompt(repairContext),
      agentRuns: slice.agentRuns.map((run) => ({
        id: run.id,
        role: run.role,
        actor: run.actor,
        status: run.status,
        driver: run.driver,
        attempt: run.attempt,
      })),
      nextCommand,
      nextCommandPurpose,
    };
  });
  const compactActionableSlice = (slice: (typeof summarizedSlices)[number]) => ({
    id: slice.id,
    title: slice.title,
    status: slice.status,
    targetId: slice.targetId,
    targetName: slice.targetName,
    laneId: slice.laneId,
    laneName: slice.laneName,
    sourceDomains: slice.sourceDomains,
    frAcRefs: slice.frAcRefs.slice(0, 12),
    omittedFrAcRefs: Math.max(0, slice.frAcRefs.length - 12),
    leases: slice.leases.slice(0, 12),
    omittedLeases: Math.max(0, slice.leases.length - 12),
    evidenceKinds: slice.evidenceKinds,
    hasWorkerEvidence: slice.hasWorkerEvidence,
    hasReviewEvidence: slice.hasReviewEvidence,
    hasCommandEvidence: slice.hasCommandEvidence,
    reviewStatus: slice.reviewStatus,
    retryCount: slice.retryCount,
    repairContext: slice.repairContext,
    agentRunCount: slice.agentRuns.length,
    agentRuns: slice.agentRuns.slice(-3),
    nextCommand: slice.nextCommand,
    nextCommandPurpose: slice.nextCommandPurpose,
  });
  const activeSlices = summarizedSlices.filter((slice) => !["accepted", "closed"].includes(slice.status));
  const activeSliceQueue = activeSlices.map(compactActionableSlice);
  const escalationSummary = summarizeEscalationsForPrompt(input.snapshot.activeEscalations);
  const acceptedSlices = summarizedSlices.filter((slice) => slice.status === "accepted");
  const focusQueue = buildOverseerFocusQueue({
    store: input.store,
    workspace: input.workspace,
    snapshot: input.snapshot,
    cli,
  });
  return {
    scenario: input.scenario,
    runMode: input.snapshot.runMode,
    generatedAt: input.snapshot.generatedAt,
    execution: {
      executeEnabled: input.execute,
      harnessExecutesRecommendations: true,
      agentMustNotInvokeTools: true,
      deterministicVerification: "The live runner executes deterministic verification after reviewer acceptance.",
    },
    actionableState: {
      focusQueue,
      activeSliceQueue,
      nextSourcePullQueue: sourcePullQueues.ready.slice(0, 8).map((item) => ({
        ...item,
        availableRefCount: item.availableRefs.length,
        availableRefs: item.availableRefs.slice(0, 12),
        omittedAvailableRefs: Math.max(0, item.availableRefs.length - 12),
      })),
      blockedSourceQueue: sourcePullQueues.blocked.slice(0, 8).map((item) => ({
        ...item,
        availableRefCount: item.availableRefs.length,
        availableRefs: item.availableRefs.slice(0, 12),
        omittedAvailableRefs: Math.max(0, item.availableRefs.length - 12),
      })),
      acceptedSliceCount: acceptedSlices.length,
      acceptedSliceIds: acceptedSlices.map((slice) => slice.id).slice(-20),
      blockedSliceIds: summarizedSlices.filter((slice) => slice.status === "blocked").map((slice) => slice.id),
    },
    targets: input.snapshot.targets.map((target) => ({ id: target.id, name: target.name, path: target.path })),
    sources: input.snapshot.sources.map((source) => summarizeSourceForPrompt(source)),
    domains: input.snapshot.domains.map((domain) => ({
      domain: domain.domain,
      available: domain.available,
      active: domain.active,
      blocked: domain.blocked,
      completed: domain.completed,
      activeSlices: domain.activeSlices,
      blockedSlices: domain.blockedSlices,
      acceptedSlices: domain.acceptedSlices,
      tags: domain.tags,
      sourceIds: domain.sourceIds,
    })),
    lanes: input.snapshot.lanes.map((lane) => ({
      id: lane.id,
      name: lane.name,
      purpose: lane.purpose,
      state: lane.state,
      targetId: lane.targetId,
      targetName: targetById.get(lane.targetId)?.name,
      activeLeaseCount: lane.activeLeases.length,
      activeLeases: lane.activeLeases.slice(0, 12),
      activeSliceIds: activeSliceQueue.filter((slice) => slice.laneId === lane.id).map((slice) => slice.id),
    })),
    sliceSummary: {
      total: summarizedSlices.length,
      byStatus: countBy(summarizedSlices.map((slice) => slice.status)),
      active: activeSliceQueue,
      recentAccepted: acceptedSlices.slice(-5).map(compactActionableSlice),
    },
    agentRunSummary: {
      total: input.snapshot.agentRuns.length,
      byStatus: countBy(input.snapshot.agentRuns.map((run) => run.status)),
      byRole: countBy(input.snapshot.agentRuns.map((run) => run.role ?? "unknown")),
      recent: input.snapshot.agentRuns.slice(-10).map((run) => ({
        id: run.id,
        role: run.role,
        actor: run.actor,
        status: run.status,
        driver: run.driver,
        entityType: run.entityType,
        entityId: run.entityId,
        sliceId: run.sliceId,
        updatedAt: run.updatedAt,
      })),
    },
    activeEscalationSummary: escalationSummary.summary,
    activeEscalations: escalationSummary.items.map((escalation) => ({
      id: escalation.id,
      level: escalation.level,
      entityType: escalation.entityType,
      entityId: escalation.entityId,
      message: escalation.message,
    })),
    recentEvents: input.snapshot.recentEvents.slice(-8).map((event) => ({
      timestamp: event.timestamp,
      actor: event.actor,
      type: event.type,
      entityType: event.entityType,
      entityId: event.entityId,
      payloadSummary: summarizePromptPayload(event.payload),
    })),
  };
}

function summarizeScenarioManifestForPrompt(manifest: ScenarioManifestLoad): ScenarioManifestLoad {
  const data = manifest.data;
  const targets = Array.isArray(data.targets)
    ? data.targets.slice(0, 10).map((target) => {
        const record = promptRecord(target);
        return {
          name: stringProp(record, "name"),
          role: stringProp(record, "role"),
          path: stringProp(record, "path"),
          source: stringProp(record, "source"),
        };
      })
    : undefined;
  const sources = Array.isArray(data.sources)
    ? data.sources.slice(0, 10).map((source) => {
        const record = promptRecord(source);
        return {
          id: stringProp(record, "id"),
          title: stringProp(record, "title"),
          uri: stringProp(record, "uri"),
          domain: stringProp(record, "domain"),
        };
      })
    : undefined;
  const commands = promptRecord(data.commands);
  const fullProductMode = promptRecord(data.fullProductMode);

  return {
    path: manifest.path,
    exists: manifest.exists,
    data: {
      scenarioId: stringProp(data, "scenarioId"),
      runMode: stringProp(data, "runMode"),
      phase: stringProp(data, "phase"),
      mode: stringProp(data, "mode"),
      workspace: stringProp(data, "workspace"),
      productSpec: stringProp(data, "productSpec"),
      expectedOutcome: stringProp(data, "expectedOutcome"),
      limits: data.limits,
      fullProductMode: Object.keys(fullProductMode).length
        ? {
            plannedCommand: stringProp(fullProductMode, "plannedCommand"),
            productSpec: stringProp(fullProductMode, "productSpec"),
            maxSlices: fullProductMode.maxSlices,
            maxAgentRuns: fullProductMode.maxAgentRuns,
            maxRuntimeMinutes: fullProductMode.maxRuntimeMinutes,
            maxTurns: fullProductMode.maxTurns,
          }
        : undefined,
      targets,
      sources,
      commandKeys: Object.keys(commands),
    },
  };
}

function promptRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringProp(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

function summarizeSourceForPrompt(source: SourceRecord) {
  const refs = sourceFrAcRefs(source);
  const refPreview = refs.slice(0, 4);
  return {
    id: source.id,
    title: source.title,
    uri: source.uri,
    domain: sourceDomain(source),
    priority: sourcePriority(source),
    tags: sourceTags(source),
    dependsOn: sourceDependsOn(source),
    frAcRefCount: refs.length,
    frAcRefs: refPreview,
    omittedFrAcRefs: Math.max(0, refs.length - refPreview.length),
  };
}

function summarizeEscalationsForPrompt(escalations: ReturnType<typeof buildObservabilitySnapshot>["activeEscalations"]) {
  const highSeverity = escalations.filter((item) => item.level !== "warning" && item.level !== "info");
  const lowSeverity = escalations.filter((item) => item.level === "warning" || item.level === "info").slice(-6);
  const itemsById = new Map([...highSeverity, ...lowSeverity].map((item) => [item.id, item]));
  const items = [...itemsById.values()];
  return {
    items,
    summary: {
      total: escalations.length,
      included: items.length,
      omitted: Math.max(0, escalations.length - items.length),
      byLevel: countBy(escalations.map((item) => item.level)),
    },
  };
}

function buildOverseerSourcePullQueues(snapshot: ReturnType<typeof buildObservabilitySnapshot>, cli: string) {
  const ready: Array<{
    sourceId: string;
    sourceTitle: string;
    sourceDomain: string;
    targetId: string;
    targetName: string;
    availableRefs: string[];
    batchSize: number;
    nextCommand: string;
    reason: string;
  }> = [];
  const blocked: Array<{
    sourceId: string;
    sourceTitle: string;
    sourceDomain: string;
    targetId?: string;
    targetName?: string;
    availableRefs: string[];
    dependsOn: string[];
    missingDependencies: string[];
    reason: string;
    prerequisiteCommands: string[];
  }> = [];

  const sourceSummaries = snapshot.sources
    .map((source) => {
      const target = targetForSource(snapshot, source);
      const refs = sourceFrAcRefs(source);
      const availableRefs = refs.filter((ref) => sourceRefIsAvailable(snapshot, source, ref));
      const dependsOn = sourceDependsOn(source);
      const missingDependencies = dependsOn.filter((ref) => latestSnapshotLeaseForRef(snapshot, ref)?.status !== "completed");
      return {
        source,
        target,
        refs,
        availableRefs,
        dependsOn,
        missingDependencies,
      };
    })
    .filter((item) => item.target && item.availableRefs.length > 0)
    .sort((left, right) => sourcePriority(left.source) - sourcePriority(right.source) || left.source.title.localeCompare(right.source.title));

  for (const item of sourceSummaries) {
    const target = item.target;
    if (!target) continue;
    const domain = sourceDomain(item.source);
    if (item.missingDependencies.length > 0) {
      blocked.push({
        sourceId: item.source.id,
        sourceTitle: item.source.title,
        sourceDomain: domain,
        targetId: target.id,
        targetName: target.name,
        availableRefs: item.availableRefs,
        dependsOn: item.dependsOn,
        missingDependencies: item.missingDependencies,
        reason: `Missing accepted prerequisite refs: ${item.missingDependencies.join(", ")}.`,
        prerequisiteCommands: prerequisitePullCommandsFor(snapshot, cli, item.missingDependencies),
      });
      continue;
    }

    const batchSize = suggestedSourcePullBatchSize(item.source, item.availableRefs);
    ready.push({
      sourceId: item.source.id,
      sourceTitle: item.source.title,
      sourceDomain: domain,
      targetId: target.id,
      targetName: target.name,
      availableRefs: item.availableRefs,
      batchSize,
      nextCommand: `${cli} slices pull --target ${target.name} --source ${item.source.id} --batch-size ${batchSize}`,
      reason: `Source has ${item.availableRefs.length} unclaimed FR/AC refs and all declared source dependencies are accepted.`,
    });
  }

  return { ready, blocked };
}

function suggestedSourcePullBatchSize(source: SourceRecord, availableRefs: string[]): number {
  if (availableRefs.length === 0) return 1;
  const firstFamily = frAcFamilyKey(availableRefs[0]);
  if (firstFamily) {
    const familySize = availableRefs.filter((ref) => frAcFamilyKey(ref) === firstFamily).length;
    if (familySize > 1) return Math.min(12, familySize);
  }
  return isDashboardSource(source) ? Math.min(3, availableRefs.length) : 1;
}

function frAcFamilyKey(ref: string): string | undefined {
  const normalized = ref.toUpperCase();
  const acMatch = /^AC-(.+)-([0-9]+)\.[0-9]+$/.exec(normalized);
  if (acMatch) return `${acMatch[1]}-${acMatch[2]}`;
  const frMatch = /^FR-(.+)-([0-9]+)$/.exec(normalized);
  if (frMatch) return `${frMatch[1]}-${frMatch[2]}`;
  return undefined;
}

function prerequisitePullCommandsFor(
  snapshot: ReturnType<typeof buildObservabilitySnapshot>,
  cli: string,
  missingDependencies: string[],
): string[] {
  const commands: string[] = [];
  for (const missingRef of missingDependencies) {
    const source = snapshot.sources.find((candidate) => sourceFrAcRefs(candidate).includes(missingRef));
    if (!source) continue;
    const target = targetForSource(snapshot, source);
    if (!target) continue;
    if (!sourceRefIsAvailable(snapshot, source, missingRef)) continue;
    commands.push(`${cli} slices pull --target ${target.name} --source ${source.id} --batch-size 1`);
  }
  return [...new Set(commands)];
}

function targetForSource(snapshot: ReturnType<typeof buildObservabilitySnapshot>, source: SourceRecord) {
  const sourcePath = path.resolve(source.uri).toLowerCase();
  const pathMatchedTarget = snapshot.targets.find((target) => {
    const targetPath = path.resolve(target.path).toLowerCase();
    return sourcePath === targetPath || sourcePath.startsWith(`${targetPath}${path.sep}`);
  });
  if (pathMatchedTarget) return pathMatchedTarget;

  const descriptor = [
    source.title,
    sourceDomain(source),
    ...sourceTags(source),
    path.basename(source.uri),
  ]
    .join(" ")
    .toLowerCase();
  const ranked = snapshot.targets
    .map((target) => ({ target, score: targetSourceAffinityScore(target, descriptor) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.target.name.localeCompare(right.target.name));
  return ranked[0]?.target;
}

function targetSourceAffinityScore(
  target: ReturnType<typeof buildObservabilitySnapshot>["targets"][number],
  sourceDescriptor: string,
): number {
  const targetDescriptor = `${target.name} ${target.path}`.toLowerCase();
  let score = 0;
  if (/\b(api|backend|server)\b/.test(sourceDescriptor) && /\b(api|backend|server)\b/.test(targetDescriptor)) score += 5;
  if (/\b(frontend|dashboard|ui|web|design|design-system|accessibility)\b/.test(sourceDescriptor) && /\b(frontend|dashboard|ui|web)\b/.test(targetDescriptor)) score += 5;
  if (sourceDescriptor.includes("product") && /\b(frontend|dashboard|ui|web)\b/.test(targetDescriptor)) score += 2;
  for (const token of target.name.toLowerCase().split(/[^a-z0-9]+/).filter((item) => item.length > 1)) {
    if (sourceDescriptor.includes(token)) score += 1;
  }
  return score;
}

function sourceDependsOn(source: SourceRecord): string[] {
  const metadata = source.metadata as SourceIndexMetadata | undefined;
  return Array.isArray(metadata?.dependsOn)
    ? [...new Set(metadata.dependsOn.map((ref) => String(ref).toUpperCase()).filter(Boolean))]
    : [];
}

function sourceRefIsAvailable(snapshot: ReturnType<typeof buildObservabilitySnapshot>, source: SourceRecord, ref: string): boolean {
  const lease = latestSnapshotLeaseForRef(snapshot, ref);
  if (lease && lease.status !== "released") return false;
  return !isBroadFrSatisfiedByCompletedSnapshotAcs(snapshot, ref, sourceFrAcRefs(source));
}

function latestSnapshotLeaseForRef(snapshot: ReturnType<typeof buildObservabilitySnapshot>, ref: string) {
  const normalizedRef = ref.toUpperCase();
  return snapshot.slices
    .flatMap((slice) => slice.leases)
    .filter((lease) => lease.frAcRef.toUpperCase() === normalizedRef)
    .sort((left, right) => snapshotLeaseStatusPriority(left.status) - snapshotLeaseStatusPriority(right.status) || right.updatedAt.localeCompare(left.updatedAt))
    .at(0);
}

function snapshotLeaseStatusPriority(status: string): number {
  if (status === "active") return 0;
  if (status === "completed") return 1;
  return 2;
}

function isBroadFrSatisfiedByCompletedSnapshotAcs(
  snapshot: ReturnType<typeof buildObservabilitySnapshot>,
  ref: string,
  refs: string[],
): boolean {
  const match = /^FR-(.+)-([0-9]+)$/i.exec(ref);
  if (!match) return false;
  const acPrefix = `AC-${match[1]}-${match[2]}.`.toUpperCase();
  const childAcs = refs.filter((candidate) => candidate.toUpperCase().startsWith(acPrefix));
  if (childAcs.length === 0) return false;
  return childAcs.every((candidate) => latestSnapshotLeaseForRef(snapshot, candidate)?.status === "completed");
}

function isDashboardSource(source: SourceRecord): boolean {
  return /(?:dashboard|frontend|\bui\b|web|design|design-system|accessibility)/i.test(`${source.title} ${sourceDomain(source)} ${sourceTags(source).join(" ")}`);
}

function isFrontendTargetOrSlice(
  target: ReturnType<typeof buildObservabilitySnapshot>["targets"][number] | undefined,
  slice: SliceRecord,
  sourceDomains: string[],
): boolean {
  const haystack = [
    target?.name,
    target?.path,
    slice.title,
    slice.deliveryQuestion,
    ...slice.frAcRefs,
    ...sourceDomains,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return /(?:dashboard|frontend|\bui\b|-ui-|web|design|design-system|accessibility)/i.test(haystack);
}

function buildOverseerPrompt(input: {
  workspace: string;
  store: SwarmStore;
  scenario: string;
  manifest: ScenarioManifestLoad;
  snapshot: ReturnType<typeof buildObservabilitySnapshot>;
  execute: boolean;
  skillPacket?: string;
}): string {
  const statePacket = buildOverseerStatePacket({
    workspace: input.workspace,
    store: input.store,
    scenario: input.scenario,
    snapshot: input.snapshot,
    execute: input.execute,
  });
  return `You are the visible overseer agent for the Agent Swarm live smoke harness.

Scenario:
${input.scenario}

Workspace:
${input.workspace}

${input.skillPacket ? `${input.skillPacket}\n` : ""}
Your current execution mode:
${input.execute ? "- Bounded command execution is enabled after your decision is recorded." : "- Planning only; the harness will record your decision but will not execute recommended commands."}
- You may recommend worker and reviewer child-agent dispatch only through harness commands when execution is enabled.
- The harness executes recommended commands after your JSON decision. Do not run commands yourself.
- The harness runs deterministic verification automatically after reviewer acceptance. Do not recommend verifier dispatch unless a human asks for diagnostics.
- Do not edit target code.
- Do not mutate source specs.
- Recommend exact harness commands that move harness state forward.
${input.execute ? "- The harness may execute allowlisted state commands plus bounded child dispatch: run/review with an existing slice id, explicit --actor, and --driver codex." : "- A human or later runner may execute recommended commands next."}

Planning priorities:
- Use immutable source specs and FR/AC refs as the source of truth.
- Backend capabilities must be accepted before real frontend/dashboard slices are served against them.
- Prefer meaningful component/capability slices over proof-only or AC-churn slices.
- If a required manifest, source, target, or state boundary is missing, report a blocker with scope and next action.
- Keep commands inside the harness contract; never recommend direct SQLite edits or hidden state mutation.

Decision discipline:
- You already have the authoritative actionable state packet below. Do not read prompt files, list artifacts, query SQLite, grep state files, or invoke harness commands yourself.
- If actionableState.focusQueue has an item, treat it as a required senior-developer zoom-in before revive/restart/escalation. Use its inspect commands only when the active slice lacks concrete repair context.
- If an active repairing slice includes repairContext.latestReview.requiredFixes or repairContext.humanFeedback, recommend its nextCommand once as a targeted repair dispatch before further inspect churn.
- If retryCount is high and repairContext is present, do not keep recommending inspect-only turns; either dispatch the targeted repair command or block with a precise escalation.
- If actionableState.activeSliceQueue has an item with nextCommand, recommend that exact command first unless a listed blocker makes it unsafe.
- If there is no active slice and actionableState.nextSourcePullQueue has an item with nextCommand, recommend the first queue item before any blocked downstream source.
- Never recommend a slices pull command for an item in actionableState.blockedSourceQueue; use its missingDependencies and prerequisiteCommands to continue prerequisite work first.
- Do not recommend domains inspect or observe solely to discover a slice id that already appears in actionableState.activeSliceQueue.
- Use observe/domains inspect only when actionableState explicitly lacks a concrete slice id or when you need to confirm a blocker.
- Return one JSON object only.

Allowed command contract:
- node "${process.argv[1]}" observe --events 120
- node "${process.argv[1]}" sources list
- node "${process.argv[1]}" domains list
- node "${process.argv[1]}" domains inspect <domain>
- node "${process.argv[1]}" inspect run <run-id>
- node "${process.argv[1]}" inspect slice <slice-id>
- node "${process.argv[1]}" slices pull --target <target> --source <source> --batch-size <n> [lane options]
- node "${process.argv[1]}" run <slice-id> --actor <actor> --driver codex
- node "${process.argv[1]}" review <slice-id> --actor <actor> --driver codex
- node "${process.argv[1]}" report <slice-id>
- node "${process.argv[1]}" checkpoint create --role <role> --entity <type:id> --summary <summary>
- node "${process.argv[1]}" escalations create --level <level> --entity <type:id> --message <message>

Scenario manifest:
${jsonForPrompt(summarizeScenarioManifestForPrompt(input.manifest))}

Current harness snapshot:
${jsonForPrompt(statePacket)}

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
  return `You are the visible overseer agent for Agent Swarm scenario ${scenario}.

Read the overseer prompt artifact below before deciding:
${promptPath}

That artifact contains the authoritative current harness snapshot, allowed command contract, and decision discipline.
Use only that artifact and the files it explicitly points to. Do not inspect unrelated state files or mutate target/source files.
Return only the required JSON object for scenario ${scenario}.`;
}

function getOverseerEscalationSuppressionReason(input: {
  blocker: OverseerDecision["blockers"][number];
  activeEscalations: ReturnType<SwarmStore["listEscalations"]>;
  entityId: string;
}): string | undefined {
  const message = String(input.blocker.message ?? "");
  const normalizedMessage = normalizeEscalationMessage(message);
  const sameScope = input.activeEscalations.filter(
    (item) => item.status === "active" && item.entityType === "harness" && item.entityId === input.entityId,
  );
  const duplicate = sameScope.find(
    (item) => item.level === input.blocker.level && normalizeEscalationMessage(item.message) === normalizedMessage,
  );
  if (duplicate) return `duplicate active escalation ${duplicate.id}`;

  if (input.blocker.level !== "warning") return undefined;
  if (isNonBlockingWarningRestatement(message)) {
    return "non-blocking warning restatement; existing warnings remain visible";
  }

  const duplicateWarningFamily = sameScope.find(
    (item) => item.level === "warning" && isSameOperationalWarningFamily(item.message, message),
  );
  if (duplicateWarningFamily) return `duplicate warning family already active as ${duplicateWarningFamily.id}`;
  return undefined;
}

function normalizeEscalationMessage(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\b(?:escalation|warning|blocker)-[a-z0-9]+\b/g, "<id>")
    .replace(/\bSLICE-[a-f0-9]+\b/gi, "<slice>")
    .replace(/\s+/g, " ")
    .trim();
}

function isNonBlockingWarningRestatement(message: string): boolean {
  return (
    /(existing .*warnings?|warning remains|warnings remain|warning restatement)/i.test(message) &&
    /(does not block|do not block|not mark(?:ed)? .*blocking|authoritative snapshot|remain visible|remains visible)/i.test(message)
  );
}

function isSameOperationalWarningFamily(left: string, right: string): boolean {
  const combined = `${left}\n${right}`;
  if (/low[- ]signal|proof[- ]churn|meaningful dependencies/i.test(combined)) {
    return (
      /low[- ]signal|proof[- ]churn|meaningful dependencies/i.test(left) &&
      /low[- ]signal|proof[- ]churn|meaningful dependencies/i.test(right)
    );
  }
  if (/git permission warnings?|unable to access .*git\/ignore|untracked `.swarm\/?`|untracked \.swarm/i.test(combined)) {
    return (
      /git permission warnings?|unable to access .*git\/ignore|untracked `.swarm\/?`|untracked \.swarm/i.test(left) &&
      /git permission warnings?|unable to access .*git\/ignore|untracked `.swarm\/?`|untracked \.swarm/i.test(right)
    );
  }
  if (/skill[_ -]isolation[_ -]conflict|user[- ]global skill|global .*skill/i.test(combined)) {
    return (
      /skill[_ -]isolation[_ -]conflict|user[- ]global skill|global .*skill/i.test(left) &&
      /skill[_ -]isolation[_ -]conflict|user[- ]global skill|global .*skill/i.test(right)
    );
  }
  return false;
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
  driver: string;
  costUsd?: number;
  resultArtifactRecovered?: boolean;
  recoveryReason?: string;
  skillBinding?: SkillBindingResult;
  skillIsolationFindings?: SkillIsolationFinding[];
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

  const activeEscalations = input.store.listEscalations("active");
  for (const blocker of blockers) {
    const suppressionReason = getOverseerEscalationSuppressionReason({
      blocker,
      activeEscalations,
      entityId: input.entityId,
    });
    if (suppressionReason) {
      input.store.addEvent(
        createEvent({
          actor: input.actor,
          type: "overseer.escalation_suppressed",
          entityType: "harness",
          entityId: input.entityId,
          payload: {
            level: blocker.level,
            message: blocker.message,
            scope: blocker.scope,
            reason: suppressionReason,
          },
        }),
      );
      continue;
    }
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
    activeEscalations.push(escalation);
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
        driver: input.driver,
        costUsd: input.costUsd,
        resultArtifactRecovered: input.resultArtifactRecovered,
        recoveryReason: input.recoveryReason,
        skills: input.skillBinding ? summarizeSkillBinding(input.skillBinding) : undefined,
        skillBindingPath: input.skillBinding?.bindingPath,
        skillPacketPath: input.skillBinding?.packetPath,
        skillIsolationFindings: input.skillIsolationFindings ?? [],
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
      cwd: process.cwd(),
      shell: false,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, SWARM_WORKSPACE: input.workspace },
    });
    fs.writeFileSync(stdoutPath, result.stdout ?? "", "utf8");
    fs.writeFileSync(stderrPath, result.stderr ?? "", "utf8");

    const stderrText = (result.stderr ?? "").trim();
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
      reason: result.status === 0 ? undefined : stderrText || result.error?.message || `Command exited with status ${result.status}`,
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
  if (commandName === "inspect" && (subcommand === "run" || subcommand === "slice")) {
    return validateOverseerInspectCommand(cliArgs, store);
  }
  if (commandName === "slices" && subcommand === "pull") {
    const dependencyValidation = validateSlicesPullDependencies(cliArgs, workspace, store);
    if (!dependencyValidation.ok) return dependencyValidation;
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
      reason: "The live runner owns deterministic verification after reviewer acceptance; do not dispatch verifier commands from overseer decisions.",
    };
  }
  if (["checkpoint", "escalations"].includes(commandName)) {
    return { ok: false, reason: "The harness records overseer decisions directly and does not execute checkpoint/escalation commands." };
  }
  return { ok: false, reason: `Command is not allowlisted for overseer bounded execution: ${commandName}${subcommand ? ` ${subcommand}` : ""}` };
}

function validateOverseerInspectCommand(
  cliArgs: string[],
  store: SwarmStore,
): OverseerCommandValidation {
  const [, inspectType, id, ...options] = cliArgs;
  if (!inspectType || (inspectType !== "run" && inspectType !== "slice")) {
    return { ok: false, reason: "Inspect commands must be `inspect run <run-id>` or `inspect slice <slice-id>`." };
  }
  if (!id || id.startsWith("-")) {
    return { ok: false, reason: `Missing id for inspect ${inspectType}.` };
  }
  if (options.some((option) => option !== "--json")) {
    return { ok: false, reason: "Inspect commands only allow the optional --json flag." };
  }
  if (inspectType === "run" && !store.listAgentRuns().some((run) => run.id === id)) {
    return { ok: false, reason: `Cannot inspect run; agent run not found: ${id}` };
  }
  if (inspectType === "slice" && !store.listSlices().some((slice) => slice.id === id)) {
    return { ok: false, reason: `Cannot inspect slice; slice not found: ${id}` };
  }
  return { ok: true, cliArgs, commandKey: `inspect ${inspectType}`, category: "state" };
}

function validateSlicesPullDependencies(
  cliArgs: string[],
  workspace: string,
  store: SwarmStore,
): { ok: true } | { ok: false; reason: string } {
  const sourceSelector = cliOptionValue(cliArgs.slice(2), "--source");
  if (!sourceSelector) return { ok: true };
  const source = selectSourceForCommandValidation(store, sourceSelector, workspace);
  if (!source) return { ok: false, reason: `Cannot pull slice; source not found: ${sourceSelector}` };
  const missingDependencies = sourceDependsOn(source).filter((ref) => store.latestLeaseFor(ref)?.status !== "completed");
  if (missingDependencies.length === 0) return { ok: true };
  return {
    ok: false,
    reason: `Source dependencies are not satisfied: ${missingDependencies.join(", ")}`,
  };
}

function selectSourceForCommandValidation(store: SwarmStore, selector: string, workspace: string): SourceRecord | undefined {
  const raw = selector.toLowerCase();
  const resolved = path.resolve(workspace, selector).toLowerCase();
  return store.listSources().find((source) => {
    const uri = source.uri.toLowerCase();
    return (
      source.id.toLowerCase() === raw ||
      source.title.toLowerCase() === raw ||
      uri === raw ||
      uri === resolved ||
      path.basename(source.uri).toLowerCase() === raw
    );
  });
}

function cliOptionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
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

function summarizeSkillBinding(binding: SkillBindingResult) {
  return {
    role: binding.role,
    runId: binding.runId,
    bindingPath: binding.bindingPath,
    packetPath: binding.packetPath,
    boundRoot: binding.boundRoot,
    required: binding.required.map(summarizeSkill),
    optional: binding.optional.map(summarizeSkill),
    count: binding.skills.length,
  };
}

function summarizeSkill(skill: SkillBindingResult["skills"][number]) {
  return {
    id: skill.id,
    requirement: skill.requirement,
    source: skill.source,
    sourcePath: skill.sourcePath,
    boundPath: skill.boundPath,
    hash: skill.hash,
    title: skill.title,
    description: skill.description,
  };
}

function buildWorkerPrompt(input: {
  slice: SliceRecord;
  targetPath: string;
  laneName?: string;
  skillPacket?: string;
  repairContext?: SliceRepairContext;
}): string {
  const sourceRefs = input.slice.sourceRefs
    .map((source) => `- ${source.title ?? source.uri}: ${source.uri}`)
    .join("\n");
  const safeDirectoryPath = formatGitSafeDirectoryPath(input.targetPath);
  return `You are an implementation worker inside the Agent Swarm MVP harness.

Target workspace:
${input.targetPath}

Lane:
${input.laneName ?? input.slice.laneId}

${input.skillPacket ? `${input.skillPacket}\n` : ""}
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

Verification obligations (read-only):
${formatVerificationObligations(input.slice)}

Scope:
${input.slice.scope.map((item) => `- ${item}`).join("\n")}

Out of scope:
${input.slice.outOfScope.map((item) => `- ${item}`).join("\n")}

Expected evidence:
${input.slice.expectedEvidence.map((item) => `- ${item}`).join("\n")}

Verification requirements:
${input.slice.verificationRequirements.map((item) => `- ${item}`).join("\n")}

${formatRepairContextForPrompt(input.repairContext)}

Instructions:
- Implement only this slice scope.
- Do not modify source spec files.
- Do not create, edit, weaken, or reinterpret verification obligations.
- Prefer minimal, behavior-focused changes.
- Run relevant target tests if available.
- If Git reports dubious ownership, prefer per-command safe-directory usage such as git -c safe.directory=${safeDirectoryPath} status --short; use the normalized forward-slash path and do not mutate global Git config.
- Provide frAcCoverage for every in-scope FR/AC ref.
- Map frAcCoverage evidence to the read-only verification obligations above.
- Return status "passed" when your implementation work and worker evidence are complete, even though the harness will still run independent review and deterministic verification after you.
- Do not return "needs_human" merely because independent review, deterministic verification, or final acceptance is still pending; those are normal harness phases.
- Return "needs_human" only when a true human decision, clarification, or human verification is required by the source/obligations before the affected scope can safely proceed.
- Return the final answer in the required structured schema.
`;
}

function formatRepairContextForPrompt(context: SliceRepairContext | undefined): string {
  if (!context) return "";
  const lines = [
    "Targeted repair context:",
    "- This section is prior review/human feedback for the current slice. It does not modify the immutable source refs or verification obligations.",
    "- Use it to repair the implementation, then return fresh worker evidence mapped to the same FR/AC refs.",
  ];
  if (context.review) {
    lines.push(
      `- Latest review evidence: ${context.review.evidenceId}`,
      `- Latest review status: ${context.review.status}`,
      `- Review summary: ${context.review.summary}`,
      `- Review recommendation: ${context.review.recommendation}`,
    );
    if (context.review.nonPassingRefs.length > 0) {
      lines.push("- Non-passing review refs:");
      for (const ref of context.review.nonPassingRefs) lines.push(`  - ${ref}`);
    }
    if (context.review.requiredFixes.length > 0) {
      lines.push("- Required fixes from independent review:");
      for (const fix of context.review.requiredFixes) lines.push(`  - ${fix}`);
    }
  }
  if (context.humanFeedback.length > 0) {
    lines.push("- Human verification feedback requiring repair:");
    for (const item of context.humanFeedback) {
      const ref = item.ref ? `${item.ref} ` : "";
      const actor = item.actor ? ` by ${item.actor}` : "";
      const packet = item.packetId ? ` packet ${item.packetId}` : "";
      const notes = item.notes?.trim() ? ` Notes: ${item.notes.trim()}` : "";
      lines.push(`  - ${ref}${item.status ?? "failed"}${actor}.${packet}${notes}`);
    }
  }
  if (context.activeEscalations.length > 0) {
    lines.push("- Active scoped blockers to resolve or supersede with evidence:");
    for (const item of context.activeEscalations) {
      const reason = item.reason?.trim() ? ` Reason: ${item.reason.trim()}` : "";
      lines.push(`  - ${item.level}: ${item.message}${reason}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function buildWorkerRevivePrompt(input: {
  slice: SliceRecord;
  targetPath: string;
  laneName?: string;
  previousRunId: string;
  previousStatus: string;
  priorResultState: string;
  skillPacket?: string;
}): string {
  return `You are being resumed by the Agent Swarm supervised recovery protocol.

Previous run:
- id: ${input.previousRunId}
- status: ${input.previousStatus}
- ${input.priorResultState}

Recovery objective:
- Inspect the current target state and your prior session context.
- If the implementation work is already complete, do not redo it; emit the required structured worker result for the slice.
- If work is incomplete, finish only the in-scope slice work, run relevant verification, and emit the required structured worker result.
- If you cannot safely complete or prove the work, return a structured blocked/failed result with exact reasons.

This is not permission to change source specs or expand scope.

${buildWorkerPrompt({ slice: input.slice, targetPath: input.targetPath, laneName: input.laneName, skillPacket: input.skillPacket })}`;
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
          "qualityGate",
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
          qualityGate: {
            type: "object",
            additionalProperties: false,
            required: ["status", "summary", "dimensions", "blockingConcerns", "residualRisks"],
            properties: {
              status: { type: "string", enum: ["passed", "warning", "failed"] },
              summary: { type: "string" },
              dimensions: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["dimension", "status", "risk", "evidence", "finding"],
                  properties: {
                    dimension: {
                      type: "string",
                      enum: [
                        "runtime_path",
                        "stub_or_hardcode",
                        "test_meaningfulness",
                        "error_handling",
                        "integration_fit",
                        "maintainability",
                        "real_world_readiness",
                      ],
                    },
                    status: { type: "string", enum: ["passed", "warning", "failed", "not_applicable"] },
                    risk: { type: "string", enum: ["none", "low", "medium", "high"] },
                    evidence: { type: "array", items: { type: "string" } },
                    finding: { type: "string" },
                  },
                },
              },
              blockingConcerns: { type: "array", items: { type: "string" } },
              residualRisks: { type: "array", items: { type: "string" } },
            },
          },
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
