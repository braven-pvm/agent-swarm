#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Command } from "commander";
import YAML from "yaml";
import { createEvent } from "./events.js";
import { runFixtureWorker } from "./fixture-worker.js";
import { makeId } from "./ids.js";
import { artifactsDir, resolveWorkspace, swarmDir } from "./paths.js";
import { pullNextSlice } from "./planner.js";
import { workerResultSchema } from "./schemas.js";
import { registerFileSource } from "./source-adapter.js";
import { SwarmStore } from "./storage.js";
import { initTarget } from "./target-init.js";
import { ingestWorkerJsonl } from "./worker-events.js";
import { loadProtocol } from "./protocol.js";

const program = new Command();

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
  .action((filePath: string) => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      const source = registerFileSource(filePath);
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
          },
        }),
      );
      console.log(`Registered source ${source.title}`);
      console.log(`  uri: ${source.uri}`);
      console.log(`  hash: ${source.hash}`);
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
  .option("--new-lane", "create a new lane instead of reusing an active lane")
  .option("--lane-name <name>", "lane name")
  .option("--lane-purpose <purpose>", "lane purpose")
  .option("--lane-labels <labels>", "comma-separated focus labels")
  .option("--orchestrator <actor>", "lead orchestrator actor", "planning-agent")
  .option("--batch-size <count>", "number of FR/AC refs to claim", parseInteger)
  .action((options: {
    target?: string;
    source?: string;
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
  .description("Run a real Codex implementation worker for a slice")
  .argument("<slice-id>", "slice identifier")
  .option("--actor <actor>", "worker actor id shown in observability", "worker")
  .option("--driver <driver>", "worker driver: codex or fixture", "codex")
  .option("--model <model>", "Codex model override")
  .action((sliceId: string, options: { actor: string; driver: string; model?: string }) => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      const result = executeWorkerRun({
        workspace,
        store,
        sliceId,
        actor: options.actor,
        driver: parseWorkerDriver(options.driver),
        model: options.model,
        reason: "direct_run",
      });
      printWorkerRunResult(result);
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
      const workerGate = readAndValidateWorkerResult(store, slice);
      const passed = commandPassed && workerGate.passed;
      store.updateSliceStatus(slice.id, passed ? "accepted" : "blocked");
      if (passed) {
        store.completeLeasesForSlice(slice.id);
      }
      store.updateDependenciesFor("slice", slice.id, passed ? "satisfied" : "blocked");
      store.insertEvidence({
        id: makeId("evidence"),
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
            stdout: trimOutput(result.stdout),
            stderr: trimOutput(result.stderr),
          },
        }),
      );
      console.log(`Verification ${passed ? "passed" : "failed"} for ${slice.id}`);
      console.log(`  command: ${command}`);
      console.log(`  exit code: ${result.status}`);
      if (!workerGate.passed) console.log(`  worker gate: ${workerGate.reason}`);
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
      const slice = store.listSlices().find((item) => item.id === sliceId);
      if (!slice) throw new Error(`Slice not found: ${sliceId}`);
      const lane = store.listLanes().find((item) => item.id === slice.laneId);
      const leases = store.listLeases().filter((lease) => lease.sliceId === slice.id);
      const evidence = store.listEvidence(slice.id);
      const escalations = store.listEscalations("active").filter((item) => item.entityId === slice.id);
      console.log(`# Slice Report: ${slice.title}`);
      console.log("");
      console.log(`Status: ${slice.status}`);
      console.log(`Slice: ${slice.id}`);
      console.log(`Lane: ${lane ? `${lane.name} (${lane.id})` : slice.laneId}`);
      console.log("");
      console.log("Source refs:");
      for (const source of slice.sourceRefs) {
        console.log(`- ${source.title ?? source.uri} (${source.uri})`);
      }
      console.log("");
      console.log("FR/AC coverage:");
      for (const ref of slice.frAcRefs) {
        console.log(`- ${ref}`);
      }
      console.log("");
      console.log("Leases:");
      for (const lease of leases) {
        console.log(`- ${lease.frAcRef}: ${lease.status}`);
      }
      console.log("");
      console.log("Evidence:");
      if (evidence.length === 0) console.log("- none");
      for (const item of evidence) {
        console.log(`- ${item.kind}: ${item.summary}${item.ref ? ` (${item.ref})` : ""}`);
      }
      console.log("");
      console.log("Active escalations:");
      if (escalations.length === 0) console.log("- none");
      for (const escalation of escalations) {
        console.log(`- ${escalation.level}: ${escalation.message}`);
      }
      console.log("");
      console.log("Verification requirements:");
      for (const req of slice.verificationRequirements) {
        console.log(`- ${req}`);
      }
    } finally {
      store.close();
    }
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
        console.log(`  - ${item.run.id} ${item.run.actor} slice:${item.run.sliceId} age:${formatDuration(item.ageMs)}`);
        if (item.heartbeat?.detail) console.log(`    heartbeat: ${item.heartbeat.state} - ${item.heartbeat.detail}`);
        if (!options.markStale && !options.release) continue;

        store.updateAgentRun(item.run.id, { status: options.release ? "released" : "stale" });
        store.upsertHeartbeat({
          id: `heartbeat:${item.run.actor}`,
          actor: item.run.actor,
          state: "blocked",
          detail: options.release ? "Stale run released by recovery scan" : "Stale run marked for recovery",
          entityType: "slice",
          entityId: item.run.sliceId,
        });
        const slice = store.listSlices().find((candidate) => candidate.id === item.run.sliceId);
        if (slice && !["accepted", "closed"].includes(slice.status)) {
          store.updateSliceStatus(slice.id, options.release ? "closed" : "blocked");
          if (options.release) store.releaseLeasesForSlice(slice.id);
        }
        const existingEscalation = store
          .listEscalations("active")
          .some((escalation) => escalation.entityId === item.run.sliceId && escalation.message.includes(item.run.id));
        if (!existingEscalation) {
          const now = new Date().toISOString();
          store.insertEscalation({
            id: makeId("escalation"),
            level: "blocker",
            status: "active",
            entityType: "slice",
            entityId: item.run.sliceId,
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
              ageMs: item.ageMs,
              staleAfterSeconds: staleAfter,
            },
          }),
        );
      }
    } finally {
      store.close();
    }
  });

recovery
  .command("revive")
  .description("Resume a stale Codex agent run by captured session id")
  .argument("<run-id>", "agent run identifier")
  .option("--actor <actor>", "recovery actor", "recovery-agent")
  .option("--model <model>", "Codex model override")
  .action((runId: string, options: { actor: string; model?: string }) => {
    const workspace = resolveWorkspace();
    ensureInitialized(workspace);
    const store = new SwarmStore(workspace);
    try {
      const previousRun = store.listAgentRuns().find((run) => run.id === runId);
      if (!previousRun) throw new Error(`Agent run not found: ${runId}`);
      if (previousRun.driver !== "codex") throw new Error(`Agent run ${runId} uses ${previousRun.driver}; only Codex runs can be revived.`);
      if (!previousRun.sessionId) throw new Error(`Agent run ${runId} does not have a captured Codex session id.`);
      const slice = store.listSlices().find((item) => item.id === previousRun.sliceId);
      if (!slice) throw new Error(`Slice not found for run ${runId}: ${previousRun.sliceId}`);
      const target = store.targetById(slice.targetId);
      if (!target) throw new Error(`Target not found for slice: ${slice.targetId}`);

      const revivedRunId = makeId("agentRun");
      const now = new Date().toISOString();
      const attempt = store.listAgentRuns().filter((run) => run.sliceId === slice.id && run.actor === previousRun.actor).length + 1;
      const artifactPath = path.join(artifactsDir(workspace), slice.id);
      fs.mkdirSync(artifactPath, { recursive: true });
      const jsonlPath = path.join(artifactPath, `codex-revive-${revivedRunId}.jsonl`);
      const lastMessagePath = path.join(artifactPath, `worker-result-${revivedRunId}.json`);
      const prompt = `Continue the implementation for slice ${slice.id}. Preserve the immutable FR/AC scope and finish with the required worker result JSON if possible.`;

      store.insertAgentRun({
        id: revivedRunId,
        sliceId: slice.id,
        actor: previousRun.actor,
        driver: "codex",
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
        detail: `Reviving Codex session ${previousRun.sessionId}`,
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

      const args = ["exec", "resume", "--json", "--skip-git-repo-check", "--output-last-message", lastMessagePath];
      if (options.model) args.push("--model", options.model);
      args.push(previousRun.sessionId, prompt);
      const result = spawnSync("codex", args, {
        cwd: target.path,
        shell: false,
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
      });
      fs.writeFileSync(jsonlPath, result.stdout ?? "", "utf8");
      const stderrPath = result.stderr ? path.join(artifactPath, `codex-revive-${revivedRunId}-stderr.log`) : undefined;
      if (stderrPath && result.stderr) fs.writeFileSync(stderrPath, result.stderr, "utf8");
      const workerEvents = ingestWorkerJsonl({
        store,
        actor: previousRun.actor,
        sliceId: slice.id,
        jsonl: result.stdout ?? "",
      });
      store.updateAgentRun(revivedRunId, {
        status: result.status === 0 ? "completed" : "failed",
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
          summary: "Structured Codex revive result",
          ref: lastMessagePath,
          payload: { path: lastMessagePath, revivedFrom: previousRun.id },
          createdAt: new Date().toISOString(),
        });
      }
      store.updateSliceStatus(slice.id, result.status === 0 ? "implemented" : "blocked");
      store.upsertHeartbeat({
        id: `heartbeat:${previousRun.actor}`,
        actor: previousRun.actor,
        state: result.status === 0 ? "idle" : "blocked",
        detail: result.status === 0 ? "Codex revive completed" : "Codex revive failed",
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
            exitCode: result.status,
            workerEvents,
          },
        }),
      );
      console.log(`${result.status === 0 ? "Revived" : "Revive failed"} for ${runId}`);
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
  .option("--driver <driver>", "worker driver: codex or fixture; defaults to previous run driver")
  .option("--model <model>", "Codex model override")
  .action((runId: string, options: { actor?: string; driver?: string; model?: string }) => {
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
      const result = executeWorkerRun({
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

function executeWorkerRun(input: {
  workspace: string;
  store: SwarmStore;
  sliceId: string;
  actor: string;
  driver: "codex" | "fixture";
  model?: string;
  reason: "direct_run" | "restart";
  previousRunId?: string;
}): {
  sliceId: string;
  runId: string;
  exitCode: number | null;
  eventsPath: string;
  resultPath: string;
  workerEvents: ReturnType<typeof ingestWorkerJsonl>;
  stderr?: string;
} {
  const slice = input.store.listSlices().find((item) => item.id === input.sliceId);
  if (!slice) throw new Error(`Slice not found: ${input.sliceId}`);
  const target = input.store.targetById(slice.targetId);
  if (!target) throw new Error(`Target not found for slice: ${slice.targetId}`);
  const lane = input.store.listLanes().find((item) => item.id === slice.laneId);
  const artifactPath = path.join(artifactsDir(input.workspace), slice.id);
  fs.mkdirSync(artifactPath, { recursive: true });
  const runId = makeId("agentRun");
  const lastMessagePath = path.join(artifactPath, input.reason === "restart" ? `worker-result-${runId}.json` : "worker-result.json");
  const jsonlPath = path.join(artifactPath, input.reason === "restart" ? `codex-events-${runId}.jsonl` : "codex-events.jsonl");
  const stderrPath = path.join(artifactPath, input.reason === "restart" ? `codex-stderr-${runId}.log` : "codex-stderr.log");
  const schemaPath = path.join(input.workspace, "schemas", "worker-result.schema.json");
  const prompt = buildWorkerPrompt({ slice, targetPath: target.path, laneName: lane?.name });
  const now = new Date().toISOString();
  const attempt = input.store.listAgentRuns().filter((run) => run.sliceId === slice.id && run.actor === input.actor).length + 1;

  input.store.updateSliceStatus(slice.id, "implementing");
  input.store.insertAgentRun({
    id: runId,
    sliceId: slice.id,
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
    detail: input.reason === "restart" ? "Fresh worker restarted for slice" : "Codex worker process started",
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
        driver: input.driver,
        model: input.model,
        runId,
        attempt,
        previousRunId: input.previousRunId,
      },
    }),
  );

  let result: { status: number | null; stdout?: string; stderr?: string };
  if (input.driver === "fixture") {
    const workerResult = runFixtureWorker({ slice, targetPath: target.path });
    fs.writeFileSync(lastMessagePath, `${JSON.stringify(workerResult)}\n`, "utf8");
    result = {
      status: 0,
      stdout: `${JSON.stringify({ type: "fixture.worker.completed", sliceId: slice.id, actor: input.actor })}\n`,
    };
  } else {
    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "-C",
      target.path,
      "--output-schema",
      schemaPath,
      "--output-last-message",
      lastMessagePath,
    ];
    if (input.model) args.push("--model", input.model);
    args.push(prompt);
    result = spawnSync("codex", args, {
      cwd: target.path,
      shell: false,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
  }

  fs.writeFileSync(jsonlPath, result.stdout ?? "", "utf8");
  if (result.stderr) fs.writeFileSync(stderrPath, result.stderr, "utf8");
  const workerEvents = ingestWorkerJsonl({
    store: input.store,
    actor: input.actor,
    sliceId: slice.id,
    jsonl: result.stdout ?? "",
  });
  input.store.updateAgentRun(runId, {
    status: result.status === 0 ? "completed" : "failed",
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
      summary: input.reason === "restart" ? "Structured worker restart result" : "Structured Codex worker result",
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
        runId,
        previousRunId: input.previousRunId,
        eventsPath: jsonlPath,
        resultPath: lastMessagePath,
        stderrPath: result.stderr ? stderrPath : undefined,
        workerEvents,
      },
    }),
  );

  input.store.updateSliceStatus(slice.id, result.status === 0 ? "implemented" : "blocked");
  input.store.upsertHeartbeat({
    id: `heartbeat:${input.actor}`,
    actor: input.actor,
    state: result.status === 0 ? "idle" : "blocked",
    detail: result.status === 0 ? `${input.driver} worker completed` : `${input.driver} worker failed`,
    entityType: "slice",
    entityId: slice.id,
  });
  return {
    sliceId: slice.id,
    runId,
    exitCode: result.status,
    eventsPath: jsonlPath,
    resultPath: lastMessagePath,
    workerEvents,
    stderr: result.stderr,
  };
}

function printWorkerRunResult(result: ReturnType<typeof executeWorkerRun>): void {
  console.log(`Worker ${result.exitCode === 0 ? "completed" : "failed"} for ${result.sliceId}`);
  console.log(`  run: ${result.runId}`);
  console.log(`  events: ${result.eventsPath}`);
  console.log(`  ingested events: ${result.workerEvents.eventCount}`);
  if (result.workerEvents.sessionId) console.log(`  session: ${result.workerEvents.sessionId}`);
  if (result.workerEvents.parseErrorCount > 0) console.log(`  event parse errors: ${result.workerEvents.parseErrorCount}`);
  console.log(`  result: ${result.resultPath}`);
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

function buildObservabilitySnapshot(store: SwarmStore, workspace: string, eventCount: number) {
  const slices = store.listSlices();
  const leases = store.listLeases();
  const evidence = store.listEvidence();
  return {
    workspace,
    generatedAt: new Date().toISOString(),
    targets: store.listTargets(),
    sources: store.listSources(),
    lanes: store.listLanes().map((lane) => ({
      ...lane,
      activeLeases: leases.filter((lease) => lease.laneId === lane.id && lease.status === "active").map((lease) => lease.frAcRef),
    })),
    slices: slices.map((slice) => ({
      ...slice,
      leases: leases.filter((lease) => lease.sliceId === slice.id),
      evidence: evidence.filter((item) => item.sliceId === slice.id),
      agentRuns: store.listAgentRuns().filter((run) => run.sliceId === slice.id),
    })),
    dependencies: store.listDependencies().map((dependency) => ({
      ...dependency,
      status: currentDependencyStatus(store, dependency),
    })),
    agentRuns: store.listAgentRuns(),
    heartbeats: store.listHeartbeats(),
    activeEscalations: store.listEscalations("active"),
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
    lines.push(`  ${run.id} ${run.actor} ${run.driver} [${run.status}] slice:${run.sliceId} attempt:${run.attempt}`);
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
    lines.push(`  stale run ${run.id} actor:${run.actor} slice:${run.sliceId}`);
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
    const heartbeat = snapshot.heartbeats.find((item) => item.actor === run.actor && item.entityId === run.sliceId);
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
      const heartbeat = heartbeats.find((item) => item.actor === run.actor && item.entityId === run.sliceId);
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

function parseGraphFormat(value: string): "json" | "dot" {
  if (value !== "json" && value !== "dot") {
    throw new Error(`Invalid graph format: ${value}. Expected json or dot.`);
  }
  return value;
}

function parseWorkerDriver(value: string): "codex" | "fixture" {
  if (value !== "codex" && value !== "fixture") {
    throw new Error(`Invalid worker driver: ${value}. Expected codex or fixture.`);
  }
  return value;
}

function readAndValidateWorkerResult(
  store: SwarmStore,
  slice: ReturnType<SwarmStore["listSlices"]>[number],
): { passed: boolean; reason: string; coveredRefs: string[] } {
  const workerEvidence = store
    .listEvidence(slice.id)
    .filter((item) => item.kind === "worker_result" && item.ref)
    .at(-1);
  if (!workerEvidence?.ref) {
    return { passed: false, reason: "missing worker_result evidence", coveredRefs: [] };
  }
  if (!fs.existsSync(workerEvidence.ref)) {
    return { passed: false, reason: `worker_result file missing: ${workerEvidence.ref}`, coveredRefs: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(workerEvidence.ref, "utf8"));
  } catch (error) {
    return {
      passed: false,
      reason: `worker_result JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
      coveredRefs: [],
    };
  }
  const result = workerResultSchema.safeParse(parsed);
  if (!result.success) {
    return { passed: false, reason: `worker_result schema failed: ${result.error.message}`, coveredRefs: [] };
  }
  if (result.data.status !== "passed") {
    return { passed: false, reason: `worker_result status is ${result.data.status}`, coveredRefs: [] };
  }
  const coveredRefs = result.data.frAcCoverage
    .filter((item) => item.status === "covered")
    .map((item) => item.ref);
  const missingRefs = slice.frAcRefs.filter((ref) => !coveredRefs.includes(ref));
  if (missingRefs.length > 0) {
    return { passed: false, reason: `worker_result missing covered refs: ${missingRefs.join(", ")}`, coveredRefs };
  }
  return { passed: true, reason: "worker_result covers every leased ref", coveredRefs };
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
      .filter((event) => event.entityId === entityId || relatedSliceIds.has(event.entityId) || relatedLaneIds.has(event.entityId))
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
  for (const source of sources) nodes.set(source.id, { id: source.id, type: "source", label: source.title });
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
  for (const event of events.filter((item) => item.type.includes("worker") || item.type.includes("verification"))) {
    const actorNode = `actor:${event.actor}`;
    nodes.set(actorNode, { id: actorNode, type: "actor", label: event.actor });
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

function buildWorkerPrompt(input: {
  slice: ReturnType<SwarmStore["listSlices"]>[number];
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

Immutable source refs:
${sourceRefs}

FR/AC scope:
${input.slice.frAcRefs.map((ref) => `- ${ref}`).join("\n")}

Scope:
${input.slice.scope.map((item) => `- ${item}`).join("\n")}

Out of scope:
${input.slice.outOfScope.map((item) => `- ${item}`).join("\n")}

Expected evidence:
${input.slice.verificationRequirements.map((item) => `- ${item}`).join("\n")}

Instructions:
- Implement only this slice scope.
- Do not modify source spec files.
- Prefer minimal, behavior-focused changes.
- Run relevant target tests if available.
- Return the final answer in the required structured schema.
`;
}
