import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SwarmStore } from "../dist/storage.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "dist", "cli.js");
const invoiceTemplate = path.join(repoRoot, "fixtures", "templates", "invoice-api");
const dashboardTemplate = path.join(repoRoot, "fixtures", "templates", "invoice-dashboard");
const productSpecSource = path.join(repoRoot, "docs", "requirements", "live-smoke-invoice-dashboard-product-spec.md");

test("codex overseer records a visible scenario planning decision", () => {
  const workspace = setupWorkspace("test-overseer-runner");
  const fakeCodexScript = writeFakeOverseerCodex();

  const output = runSwarm(
    workspace,
    ["orchestrate", "--actor", "live-overseer", "--driver", "codex", "--scenario", "live-agent-smoke"],
    {
      SWARM_CODEX_COMMAND: process.execPath,
      SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
    },
  );

  assert.match(output, /Overseer recommend_commands for live-agent-smoke/);
  assert.ok(fs.existsSync(path.join(workspace, "schemas", "overseer-decision.schema.json")));

  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "80"]));
  const run = snapshot.agentRuns.find((item) => item.actor === "live-overseer" && item.role === "overseer");
  assert.ok(run);
  assert.equal(run.driver, "codex");
  assert.equal(run.status, "completed");
  assert.equal(run.entityType, "harness");
  assert.equal(run.entityId, "scenario:live-agent-smoke");
  assert.ok(fs.existsSync(run.eventsPath));
  assert.ok(fs.existsSync(run.resultPath));

  const decision = JSON.parse(fs.readFileSync(run.resultPath, "utf8"));
  assert.equal(decision.status, "recommend_commands");
  assert.equal(decision.scenario, "live-agent-smoke");
  assert.ok(decision.recommendedCommands.some((item) => item.command.includes("slices pull")));
  const prompt = readLatestOverseerPrompt(workspace);
  assert.match(prompt, /Decision discipline:/);
  assert.match(prompt, /"actionableState"/);
  assert.match(prompt, /"activeSliceQueue"/);
  assert.match(prompt, /Do not read prompt files/);
  assert.doesNotMatch(prompt, /Deterministic verify remains blocked/);
  assert.doesNotMatch(prompt, /Phase 5B does not execute deterministic verification/);

  const heartbeat = snapshot.heartbeats.find(
    (item) => item.actor === "live-overseer" && item.entityType === "harness" && item.entityId === "scenario:live-agent-smoke",
  );
  assert.ok(heartbeat);
  assert.equal(heartbeat.state, "idle");

  assert.ok(
    snapshot.recentEvents.some(
      (event) =>
        event.type === "overseer.agent_event" &&
        event.actor === "live-overseer" &&
        event.entityType === "harness" &&
        event.entityId === "scenario:live-agent-smoke" &&
        event.payload.agentEventType === "overseer.analysis",
    ),
  );
  assert.ok(snapshot.recentEvents.some((event) => event.type === "overseer.decision_recorded"));
  assert.ok(snapshot.recentEvents.some((event) => event.type === "overseer.completed"));
  assert.ok(
    snapshot.checkpoints.some(
      (checkpoint) =>
        checkpoint.role === "overseer" &&
        checkpoint.entityType === "harness" &&
        checkpoint.entityId === "scenario:live-agent-smoke",
    ),
  );

  const watch = runSwarm(workspace, ["watch", "--once", "--view", "agents"]);
  assert.match(watch, /live-overseer/);
  assert.match(watch, /overseer/);
  assert.match(watch, /harness:scenario:live-agent-smoke/);

  const graph = JSON.parse(runSwarm(workspace, ["graph", "--format", "json"]));
  assert.ok(graph.nodes.some((node) => node.type === "actor" && node.label === "live-overseer"));
  assert.ok(graph.edges.some((edge) => edge.label === "overseer.agent_event"));
});

test("codex overseer execute mode runs allowlisted harness commands and records the trail", () => {
  const workspace = setupWorkspace("test-overseer-execute");
  const pullCommand = `node "${cli}" slices pull --target invoice-api --source invoice-api.md --new-lane --lane-name "Backend Lane: Invoice Query Core" --lane-purpose "Implement accepted invoice backend capabilities before dashboard slices" --lane-labels backend,invoice-api,live-smoke --orchestrator live-overseer --batch-size 3`;
  const observeCommand = `node "${cli}" observe --events 120`;
  const fakeCodexScript = writeFakeOverseerCodex([
    {
      command: pullCommand,
      purpose: "Serve a real backend work package with immutable FR/AC refs.",
      expectedStateChange: "A backend lane and slice are created with active leases.",
      requiresHuman: false,
    },
    {
      command: observeCommand,
      purpose: "Confirm the created slice, lane, and leases before dispatch.",
      expectedStateChange: "Snapshot shows the backend slice and no hidden worker run yet.",
      requiresHuman: false,
    },
  ]);

  const output = runSwarm(
    workspace,
    ["orchestrate", "--actor", "live-overseer", "--driver", "codex", "--scenario", "live-agent-smoke", "--execute"],
    {
      SWARM_CODEX_COMMAND: process.execPath,
      SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
    },
  );

  assert.match(output, /Overseer recommend_commands for live-agent-smoke/);
  assert.match(output, /command execution: executed 2, blocked 0, failed 0/);

  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "120"]));
  const slice = snapshot.slices.find((item) => item.targetId === snapshot.targets.find((target) => target.name === "invoice-api")?.id);
  assert.ok(slice);
  assert.equal(slice.frAcRefs.length, 3);
  assert.ok(slice.leases.every((lease) => lease.status === "active"));

  const lane = snapshot.lanes.find((item) => item.id === slice.laneId);
  assert.ok(lane);
  assert.equal(lane.name, "Backend Lane: Invoice Query Core");
  assert.equal(lane.orchestrator, "live-overseer");

  const commandsCompleted = snapshot.recentEvents.find((event) => event.type === "overseer.commands_completed");
  assert.ok(commandsCompleted);
  assert.equal(commandsCompleted.payload.executed, 2);
  assert.equal(commandsCompleted.payload.blocked, 0);
  assert.equal(commandsCompleted.payload.failed, 0);
  assert.ok(snapshot.recentEvents.some((event) => event.type === "overseer.command_started"));
  assert.ok(snapshot.recentEvents.some((event) => event.type === "overseer.command_completed"));

  const commandEvent = snapshot.recentEvents.find(
    (event) => event.type === "overseer.command_completed" && event.payload.commandKey === "slices pull",
  );
  assert.ok(commandEvent);
  assert.ok(fs.existsSync(commandEvent.payload.stdoutPath));
  assert.match(fs.readFileSync(commandEvent.payload.stdoutPath, "utf8"), /Created slice/);

  const watch = runSwarm(workspace, ["watch", "--once", "--view", "lanes"]);
  assert.match(watch, /Backend Lane: Invoice Query Core/);
  assert.match(watch, new RegExp(slice.id));
});

test("codex overseer execute mode dispatches worker and reviewer child agents", () => {
  const workspace = setupWorkspace("test-overseer-child-dispatch");
  const pullOutput = runSwarm(workspace, [
    "slices",
    "pull",
    "--target",
    "invoice-api",
    "--source",
    "invoice-api.md",
    "--new-lane",
    "--lane-name",
    "Backend Lane: Invoice Query Core",
    "--lane-purpose",
    "Implement accepted invoice backend capabilities before dashboard slices",
    "--lane-labels",
    "backend,invoice-api,live-smoke",
    "--orchestrator",
    "live-overseer",
    "--batch-size",
    "3",
  ]);
  const sliceId = pullOutput.match(/Created slice (SLICE-[a-z0-9]+)/)?.[1];
  assert.ok(sliceId);

  const runCommand = `node "${cli}" run ${sliceId} --actor live-backend-worker --driver codex`;
  const reviewCommand = `node "${cli}" review ${sliceId} --actor live-reviewer --driver codex`;
  const observeCommand = `node "${cli}" observe --events 160`;
  const fakeCodexScript = writeFakeOverseerCodex([
    {
      command: runCommand,
      purpose: "Dispatch the backend worker through the harness against the active slice.",
      expectedStateChange: "Worker agent run, heartbeat, JSONL events, and worker_result evidence appear.",
      requiresHuman: false,
    },
    {
      command: reviewCommand,
      purpose: "Dispatch the independent reviewer after worker evidence exists.",
      expectedStateChange: "Reviewer agent run, reviewer JSONL events, and review_result evidence appear.",
      requiresHuman: false,
    },
    {
      command: observeCommand,
      purpose: "Confirm child-agent state and evidence are visible after dispatch.",
      expectedStateChange: "Snapshot shows implemented/reviewed backend slice with child-agent artifacts.",
      requiresHuman: false,
    },
  ]);

  const output = runSwarm(
    workspace,
    ["orchestrate", "--actor", "live-overseer", "--driver", "codex", "--scenario", "live-agent-smoke", "--execute", "--execute-limit", "3"],
    {
      SWARM_CODEX_COMMAND: process.execPath,
      SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
    },
  );

  assert.match(output, /command execution: executed 3, blocked 0, failed 0/);
  const prompt = readLatestOverseerPrompt(workspace);
  assert.match(prompt, new RegExp(sliceId));
  assert.match(prompt, /"activeSliceQueue"/);
  assert.match(prompt, new RegExp(`"nextCommand": "node .* run ${sliceId} --actor backend-worker --driver codex"`));

  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "180"]));
  const slice = snapshot.slices.find((item) => item.id === sliceId);
  assert.ok(slice);
  assert.equal(slice.status, "ready_for_review");
  assert.ok(slice.evidence.some((item) => item.kind === "worker_result"));
  assert.ok(slice.evidence.some((item) => item.kind === "review_result"));
  assert.ok(
    snapshot.agentRuns.some(
      (run) => run.actor === "live-backend-worker" && run.role === "worker" && run.driver === "codex" && run.status === "completed",
    ),
  );
  assert.ok(
    snapshot.agentRuns.some(
      (run) => run.actor === "live-reviewer" && run.role === "reviewer" && run.driver === "codex" && run.status === "completed",
    ),
  );
  assert.ok(snapshot.recentEvents.some((event) => event.type === "worker.agent_event"));
  assert.ok(snapshot.recentEvents.some((event) => event.type === "reviewer.agent_event"));
  assert.ok(
    snapshot.recentEvents.some(
      (event) =>
        event.type === "overseer.command_completed" &&
        event.payload.commandKey === "run" &&
        event.payload.category === "child_agent" &&
        event.payload.childRole === "worker" &&
        event.payload.sliceId === sliceId,
    ),
  );
  assert.ok(
    snapshot.recentEvents.some(
      (event) =>
        event.type === "overseer.command_completed" &&
        event.payload.commandKey === "review" &&
        event.payload.category === "child_agent" &&
        event.payload.childRole === "reviewer" &&
        event.payload.sliceId === sliceId,
    ),
  );

  const workerCommandEvent = snapshot.recentEvents.find(
    (event) => event.type === "overseer.command_completed" && event.payload.commandKey === "run",
  );
  assert.ok(workerCommandEvent);
  assert.ok(fs.existsSync(workerCommandEvent.payload.stdoutPath));
  assert.match(fs.readFileSync(workerCommandEvent.payload.stdoutPath, "utf8"), /Worker completed/);

  const reviewerCommandEvent = snapshot.recentEvents.find(
    (event) => event.type === "overseer.command_completed" && event.payload.commandKey === "review",
  );
  assert.ok(reviewerCommandEvent);
  assert.ok(fs.existsSync(reviewerCommandEvent.payload.stdoutPath));
  assert.match(fs.readFileSync(reviewerCommandEvent.payload.stdoutPath, "utf8"), /Review accepted/);
});

test("codex overseer execute mode blocks verifier dispatch because the runner owns deterministic verification", () => {
  const workspace = setupWorkspace("test-overseer-execute-block");
  const fakeCodexScript = writeFakeOverseerCodex([
    {
      command: `node "${cli}" verify SLICE-not-real --actor live-verifier --force`,
      purpose: "Try to execute deterministic verification from an overseer decision.",
      expectedStateChange: "This should be blocked because the live runner owns deterministic verification after review acceptance.",
      requiresHuman: false,
    },
  ]);

  const output = runSwarm(
    workspace,
    ["orchestrate", "--actor", "live-overseer", "--driver", "codex", "--scenario", "live-agent-smoke", "--execute"],
    {
      SWARM_CODEX_COMMAND: process.execPath,
      SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
    },
  );

  assert.match(output, /command execution: executed 0, blocked 1, failed 0/);
  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "80"]));
  assert.equal(snapshot.slices.length, 0);
  assert.ok(snapshot.recentEvents.some((event) => event.type === "overseer.command_blocked"));
  const blocked = snapshot.recentEvents.find((event) => event.type === "overseer.command_blocked");
  assert.match(blocked.payload.reason, /live runner owns deterministic verification/);
});

test("overseer prompt queues backend prerequisite before blocked dashboard source", () => {
  const workspace = setupWorkspace("test-overseer-prerequisite-queue");
  const pullOutput = runSwarm(workspace, [
    "slices",
    "pull",
    "--target",
    "invoice-api",
    "--source",
    "invoice-api.md",
    "--batch-size",
    "5",
  ]);
  const pulledSnapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "40"]));
  const backendTargetId = pulledSnapshot.targets.find((target) => target.name === "invoice-api")?.id;
  const backendSliceId = pulledSnapshot.slices.find((slice) => slice.targetId === backendTargetId)?.id;
  assert.ok(backendSliceId);

  const store = new SwarmStore(workspace);
  store.updateSliceStatus(backendSliceId, "accepted");
  store.completeLeasesForSlice(backendSliceId);
  store.close();

  const fakeCodexScript = writeFakeOverseerCodex([
    {
      command: `node "${cli}" observe --events 120`,
      purpose: "Record prompt state only for regression coverage.",
      expectedStateChange: "No implementation work is dispatched.",
      requiresHuman: false,
    },
  ]);

  runSwarm(
    workspace,
    ["orchestrate", "--actor", "live-overseer", "--driver", "codex", "--scenario", "live-agent-smoke"],
    {
      SWARM_CODEX_COMMAND: process.execPath,
      SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
    },
  );

  const prompt = readLatestOverseerPrompt(workspace);
  const state = extractPromptJsonAfter(prompt, "Current harness snapshot:");
  assert.equal(state.actionableState.activeSliceQueue.length, 0);
  assert.ok(state.actionableState.nextSourcePullQueue.length > 0);
  assert.equal(state.actionableState.nextSourcePullQueue[0].targetName, "invoice-api");
  assert.deepEqual(state.actionableState.nextSourcePullQueue[0].availableRefs.slice(0, 1), ["AC-INV-003.1"]);
  assert.match(state.actionableState.nextSourcePullQueue[0].nextCommand, /slices pull --target invoice-api/);

  const blockedDashboard = state.actionableState.blockedSourceQueue.find(
    (item) => item.targetName === "invoice-dashboard",
  );
  assert.ok(blockedDashboard);
  assert.deepEqual(blockedDashboard.missingDependencies, ["AC-INV-003.1"]);
  assert.ok(blockedDashboard.prerequisiteCommands.some((command) => command.includes("--target invoice-api")));
  assert.match(prompt, /Never recommend a slices pull command for an item in actionableState\.blockedSourceQueue/);
});

test("overseer execute mode preflights dependency-blocked dashboard pulls", () => {
  const workspace = setupWorkspace("test-overseer-dashboard-preflight");
  const dashboardCommand = `node "${cli}" slices pull --target invoice-dashboard --source invoice-dashboard.md --batch-size 3`;
  const fakeCodexScript = writeFakeOverseerCodex([
    {
      command: dashboardCommand,
      purpose: "Attempt a premature dashboard pull before backend dependencies are accepted.",
      expectedStateChange: "The harness should block this before execution.",
      requiresHuman: false,
    },
  ]);

  const output = runSwarm(
    workspace,
    ["orchestrate", "--actor", "live-overseer", "--driver", "codex", "--scenario", "live-agent-smoke", "--execute"],
    {
      SWARM_CODEX_COMMAND: process.execPath,
      SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
    },
  );

  assert.match(output, /command execution: executed 0, blocked 1, failed 0/);
  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "80"]));
  assert.equal(snapshot.slices.length, 0);
  const blocked = snapshot.recentEvents.find((event) => event.type === "overseer.command_blocked");
  assert.ok(blocked);
  assert.match(blocked.payload.reason, /Source dependencies are not satisfied/);
  assert.match(blocked.payload.reason, /AC-INV-001\.1/);
});

test("overseer prompt stays compact when dashboard work becomes active", () => {
  const workspace = setupWorkspace("test-overseer-compact-dashboard-prompt");
  runSwarm(workspace, [
    "slices",
    "pull",
    "--target",
    "invoice-api",
    "--source",
    "invoice-api.md",
    "--batch-size",
    "7",
  ]);
  let snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "40"]));
  const backendTargetId = snapshot.targets.find((target) => target.name === "invoice-api")?.id;
  const backendSliceId = snapshot.slices.find((slice) => slice.targetId === backendTargetId)?.id;
  assert.ok(backendSliceId);

  const store = new SwarmStore(workspace);
  store.updateSliceStatus(backendSliceId, "accepted");
  store.completeLeasesForSlice(backendSliceId);
  store.close();

  runSwarm(workspace, [
    "slices",
    "pull",
    "--target",
    "invoice-dashboard",
    "--source",
    "invoice-dashboard.md",
    "--batch-size",
    "3",
  ]);

  const fakeCodexScript = writeFakeOverseerCodex([
    {
      command: `node "${cli}" observe --events 120`,
      purpose: "Record compact prompt state only for regression coverage.",
      expectedStateChange: "No implementation work is dispatched.",
      requiresHuman: false,
    },
  ]);
  runSwarm(
    workspace,
    ["orchestrate", "--actor", "live-overseer", "--driver", "codex", "--scenario", "live-agent-smoke"],
    {
      SWARM_CODEX_COMMAND: process.execPath,
      SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
    },
  );

  const prompt = readLatestOverseerPrompt(workspace);
  assert.ok(prompt.length < 24000, `expected compact prompt below Windows-safe limit, got ${prompt.length}`);
  const state = extractPromptJsonAfter(prompt, "Current harness snapshot:");
  assert.equal(state.actionableState.activeSliceQueue[0].targetName, "invoice-dashboard");
  assert.match(state.actionableState.activeSliceQueue[0].nextCommand, /run SLICE-/);
  assert.equal(state.activeEscalationSummary.total, state.activeEscalationSummary.included);
  snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "40"]));
  assert.ok(snapshot.slices.some((slice) => slice.targetId === snapshot.targets.find((target) => target.name === "invoice-dashboard")?.id));
});

test("overseer launches from a short prompt after dashboard worker evidence", () => {
  const workspace = setupWorkspace("test-overseer-short-launch-after-worker");
  runSwarm(workspace, [
    "slices",
    "pull",
    "--target",
    "invoice-api",
    "--source",
    "invoice-api.md",
    "--batch-size",
    "7",
  ]);
  let snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "40"]));
  const backendTargetId = snapshot.targets.find((target) => target.name === "invoice-api")?.id;
  const backendSliceId = snapshot.slices.find((slice) => slice.targetId === backendTargetId)?.id;
  assert.ok(backendSliceId);

  let store = new SwarmStore(workspace);
  store.updateSliceStatus(backendSliceId, "accepted");
  store.completeLeasesForSlice(backendSliceId);
  store.close();

  runSwarm(workspace, [
    "slices",
    "pull",
    "--target",
    "invoice-dashboard",
    "--source",
    "invoice-dashboard.md",
    "--batch-size",
    "3",
  ]);
  snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "40"]));
  const dashboardTargetId = snapshot.targets.find((target) => target.name === "invoice-dashboard")?.id;
  const dashboardSliceId = snapshot.slices.find((slice) => slice.targetId === dashboardTargetId)?.id;
  assert.ok(dashboardSliceId);

  const now = new Date().toISOString();
  store = new SwarmStore(workspace);
  store.updateSliceStatus(dashboardSliceId, "implemented");
  store.insertAgentRun({
    id: "RUN-test-dashboard-worker",
    sliceId: dashboardSliceId,
    role: "worker",
    entityType: "slice",
    entityId: dashboardSliceId,
    actor: "dashboard-worker",
    driver: "codex",
    status: "completed",
    attempt: 1,
    resultPath: path.join(workspace, ".swarm", "artifacts", dashboardSliceId, "worker-result.json"),
    eventsPath: path.join(workspace, ".swarm", "artifacts", dashboardSliceId, "worker-events.jsonl"),
    startedAt: now,
    updatedAt: now,
  });
  store.insertEvidence({
    id: "EVID-test-dashboard-worker",
    sliceId: dashboardSliceId,
    kind: "worker_result",
    summary: "dashboard worker result covered all UI refs",
    payload: {
      workerResult: {
        status: "passed",
        summary: "Implemented dashboard model against accepted backend capabilities.",
        changedFiles: ["src/dashboard.js", "test/dashboard.test.js"],
        commandsRun: Array.from({ length: 40 }, (_, index) => `command-${index}`),
        testsRun: ["npm run test in invoice-dashboard", "npm run test in invoice-api"],
        frAcCoverage: ["AC-UI-INV-001.1", "AC-UI-INV-001.2", "AC-UI-INV-001.3"].map((ref) => ({
          ref,
          status: "covered",
          evidence: "long evidence ".repeat(80),
        })),
        risks: ["git safe.directory warning"],
        nextRecommendation: "Dispatch independent review.",
      },
    },
    createdAt: now,
  });
  store.close();

  const fakeArgsPath = path.join(workspace, "fake-overseer-args.json");
  const fakeCodexScript = writeFakeOverseerCodex([
    {
      command: `node "${cli}" review ${dashboardSliceId} --actor dashboard-reviewer --driver codex`,
      purpose: "Dispatch independent dashboard review after worker evidence.",
      expectedStateChange: "Dashboard slice gains independent reviewer evidence.",
      requiresHuman: false,
    },
  ]);
  const output = runSwarm(
    workspace,
    ["orchestrate", "--actor", "live-overseer", "--driver", "codex", "--scenario", "live-agent-smoke"],
    {
      SWARM_CODEX_COMMAND: process.execPath,
      SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
      FAKE_CODEX_ARGS_PATH: fakeArgsPath,
    },
  );

  assert.match(output, /Overseer recommend_commands for live-agent-smoke/);
  const prompt = readLatestOverseerPrompt(workspace);
  assert.ok(prompt.length < 22000, `expected compact prompt artifact, got ${prompt.length}`);
  const state = extractPromptJsonAfter(prompt, "Current harness snapshot:");
  assert.equal(state.actionableState.activeSliceQueue[0].status, "implemented");
  assert.match(state.actionableState.activeSliceQueue[0].nextCommand, new RegExp(`review ${dashboardSliceId}`));
  assert.equal(state.actionableState.activeSliceQueue[0].agentRunCount, 1);
  assert.equal(state.sliceSummary.active[0].id, dashboardSliceId);

  const fakeArgs = JSON.parse(fs.readFileSync(fakeArgsPath, "utf8"));
  const launchPrompt = fakeArgs.at(-1);
  assert.equal(typeof launchPrompt, "string");
  assert.ok(launchPrompt.length < 800, `expected short OS argv launch prompt, got ${launchPrompt.length}`);
  assert.match(launchPrompt, /Read the overseer prompt artifact/);
  assert.match(launchPrompt, /overseer-prompt-RUN-/);
});

function setupWorkspace(name) {
  const workspace = path.join(repoRoot, ".swarm-demo", `${name}-${process.pid}-${Date.now()}`);
  const invoiceTarget = path.join(workspace, "invoice-api");
  const dashboardTarget = path.join(workspace, "invoice-dashboard");
  const sourceSpecsDir = path.join(workspace, "source-specs");
  const productSpec = path.join(sourceSpecsDir, "live-smoke-invoice-dashboard-product-spec.md");
  const manifestPath = path.join(workspace, "live-agent-smoke.json");

  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(invoiceTemplate, invoiceTarget, { recursive: true });
  fs.cpSync(dashboardTemplate, dashboardTarget, { recursive: true });
  fs.mkdirSync(sourceSpecsDir, { recursive: true });
  fs.copyFileSync(productSpecSource, productSpec);

  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["run-mode", "set", "live-agent-smoke"]);
  runSwarm(workspace, ["target", "init", invoiceTarget]);
  runSwarm(workspace, ["target", "init", dashboardTarget]);
  runSwarm(workspace, [
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
  runSwarm(workspace, [
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
  runSwarm(workspace, [
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

  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "20"]));
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        scenarioId: "live-agent-smoke",
        runMode: "live-agent-smoke",
        phase: "phase-4-visible-overseer",
        workspace,
        productSpec,
        expectedOutcome: "accepted_product_or_blocked_with_reasons",
        targets: [
          {
            name: "invoice-api",
            path: invoiceTarget,
            role: "backend",
            source: path.join(invoiceTarget, "specs", "invoice-api.md"),
          },
          {
            name: "invoice-dashboard",
            path: dashboardTarget,
            role: "frontend",
            source: path.join(dashboardTarget, "specs", "invoice-dashboard.md"),
          },
        ],
        sources: snapshot.sources.map((source) => ({
          id: source.id,
          title: source.title,
          uri: source.uri,
          hash: source.hash,
          domain: source.metadata?.domain ?? "Unassigned",
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return workspace;
}

function runSwarm(workspace, args, env = {}) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function readLatestOverseerPrompt(workspace) {
  const dir = path.join(workspace, ".swarm", "artifacts", "scenario-live-agent-smoke");
  const prompt = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith("overseer-prompt-") && name.endsWith(".md"))
    .map((name) => ({ name, mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((left, right) => left.mtimeMs - right.mtimeMs)
    .at(-1);
  assert.ok(prompt);
  return fs.readFileSync(path.join(dir, prompt.name), "utf8");
}

function extractPromptJsonAfter(prompt, marker) {
  const markerIndex = prompt.indexOf(marker);
  assert.notEqual(markerIndex, -1);
  const jsonStart = prompt.indexOf("{", markerIndex);
  assert.notEqual(jsonStart, -1);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = jsonStart; index < prompt.length; index += 1) {
    const char = prompt[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(prompt.slice(jsonStart, index + 1));
    }
  }
  throw new Error("Prompt JSON block did not terminate.");
}

function writeFakeOverseerCodex(recommendedCommands) {
  const fakeCodexDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-swarm-fake-overseer-"));
  const scriptPath = path.join(fakeCodexDir, "fake-overseer-codex.mjs");
  const commands = recommendedCommands ?? [
    {
      command: "node dist/cli.js slices pull --target invoice-api --source invoice-api.md --batch-size 3",
      purpose: "Serve a real backend work package with immutable FR/AC refs.",
      expectedStateChange: "A backend lane and slice are created with active leases.",
      requiresHuman: false,
    },
  ];
  fs.writeFileSync(
    scriptPath,
    `import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (process.env.FAKE_CODEX_ARGS_PATH) {
  fs.writeFileSync(process.env.FAKE_CODEX_ARGS_PATH, JSON.stringify(args, null, 2), "utf8");
}
const outputIndex = args.indexOf("--output-last-message");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
const schemaIndex = args.indexOf("--output-schema");
const schemaPath = schemaIndex >= 0 ? args[schemaIndex + 1] : "";
const refs = ["AC-INV-001.1", "AC-INV-001.2", "AC-INV-001.3"];

console.log(JSON.stringify({
  type: "thread.started",
  thread_id: schemaPath.includes("review-result")
    ? "fake-review-thread"
    : schemaPath.includes("worker-result")
      ? "fake-worker-thread"
      : "fake-overseer-thread"
}));

if (schemaPath.includes("review-result")) {
  console.log(JSON.stringify({ type: "review.analysis", status: "accepted" }));
  if (outputPath) {
    fs.writeFileSync(outputPath, JSON.stringify({
      status: "accepted",
      summary: "fake reviewer accepted overseer-dispatched backend slice",
      frAcFindings: refs.map((ref) => ({
        ref,
        status: "passed",
        evidence: ["fake-review-evidence"],
        finding: "Worker evidence and runtime changes cover this ref."
      })),
      testAssessment: "Worker evidence includes behavior-focused invoice query tests.",
      sourceMutationDetected: false,
      stubOrHardcodeRisk: "none",
      requiredFixes: [],
      escalations: [],
      recommendation: "Proceed to deterministic verification in the next acceptance phase."
    }) + "\\n", "utf8");
  }
} else if (schemaPath.includes("worker-result")) {
  console.log(JSON.stringify({ type: "item.started", item: { type: "file_change", path: "src/invoices.js" } }));
  fs.writeFileSync(path.join(process.cwd(), "src", "invoices.js"), \`const invoices = [
  { id: "INV-1001", customerId: "CUST-1", status: "open", totalCents: 12500 },
  { id: "INV-1002", customerId: "CUST-1", status: "paid", totalCents: 9900 },
  { id: "INV-1003", customerId: "CUST-2", status: "open", totalCents: 4500 },
];

export function listInvoices(filters = {}) {
  return invoices.filter((invoice) => {
    if (filters.status && invoice.status !== filters.status) return false;
    if (filters.customerId && invoice.customerId !== filters.customerId) return false;
    return true;
  });
}

export function getInvoiceSummary() {
  return { count: invoices.length };
}
\`, "utf8");
  fs.writeFileSync(path.join(process.cwd(), "test", "invoices.test.js"), \`import test from "node:test";
import assert from "node:assert/strict";
import { getInvoiceSummary, listInvoices } from "../src/invoices.js";

test("lists seeded invoices", () => {
  assert.equal(listInvoices().length, 3);
});

test("lists only open invoices when filtered by open status", () => {
  assert.deepEqual(
    listInvoices({ status: "open" }).map((invoice) => invoice.id),
    ["INV-1001", "INV-1003"],
  );
});

test("lists only invoices for the requested customer", () => {
  assert.deepEqual(
    listInvoices({ customerId: "CUST-1" }).map((invoice) => invoice.id),
    ["INV-1001", "INV-1002"],
  );
});

test("returns baseline invoice count summary", () => {
  assert.deepEqual(getInvoiceSummary(), { count: 3 });
});
\`, "utf8");
  if (outputPath) {
    fs.writeFileSync(outputPath, JSON.stringify({
      status: "passed",
      summary: "fake worker implemented invoice query filtering",
      changedFiles: ["src/invoices.js", "test/invoices.test.js"],
      commandsRun: ["npm test"],
      testsRun: ["npm test"],
      frAcCoverage: refs.map((ref) => ({
        ref,
        status: "covered",
        evidence: "Invoice query behavior is covered by listInvoices tests."
      })),
      risks: [],
      nextRecommendation: "Run independent review and deterministic verification."
    }) + "\\n", "utf8");
  }
} else {
  console.log(JSON.stringify({ type: "overseer.analysis", status: "recommend_commands" }));
  if (outputPath) {
  fs.writeFileSync(outputPath, JSON.stringify({
    status: "recommend_commands",
    summary: "Fake overseer recommends pulling the first backend capability slice.",
    scenario: "live-agent-smoke",
    currentPriority: "Create a backend invoice capability slice before dashboard work.",
    recommendedCommands: ${JSON.stringify(commands)},
    lanePlan: [{
      laneName: "Backend Lane: Invoice Query Core",
      purpose: "Complete backend invoice query behavior before dashboard work.",
      nextAction: "Pull the first backend slice."
    }],
    blockers: [],
    stopCondition: "Stop after planning decision in Phase 4.",
    nextAction: "Execute the recommended pull command through the harness."
  }) + "\\n", "utf8");
  }
}
console.log(JSON.stringify({ type: "turn.completed" }));
`,
    "utf8",
  );
  return scriptPath;
}
