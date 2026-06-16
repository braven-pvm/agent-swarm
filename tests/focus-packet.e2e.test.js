import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SwarmStore } from "../dist/storage.js";
import { createEvent } from "../dist/events.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "dist", "cli.js");

test("inspect run exposes prompt artifact and worker focus packet", () => {
  const { workspace, sliceId } = setupWorkspace("swarm-focus-worker");

  runSwarm(workspace, ["run", sliceId, "--actor", "focus-worker", "--driver", "fixture"]);
  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "40"]));
  const run = snapshot.agentRuns.find((item) => item.actor === "focus-worker");
  assert.ok(run);

  const packet = JSON.parse(runSwarm(workspace, ["inspect", "run", run.id, "--json"]));
  assert.equal(packet.kind, "run_focus");
  assert.equal(packet.run.id, run.id);
  assert.equal(packet.run.actor, "focus-worker");
  assert.equal(packet.slice.id, sliceId);
  assert.equal(packet.artifacts.prompt.exists, true);
  assert.match(fs.readFileSync(packet.artifacts.prompt.path, "utf8"), /You are an implementation worker/);
  assert.equal(packet.artifacts.result.exists, true);
  assert.ok(packet.eventStream.lineCount >= 1);
  assert.ok(packet.diagnosis.recommendedInterventions.some((item) => item.includes("normal lifecycle")));

  const human = runSwarm(workspace, ["inspect", "run", run.id]);
  assert.match(human, /Run Focus:/);
  assert.match(human, /Prompt:/);
});

test("inspect run classifies failed command and missing structured result", () => {
  const { workspace, sliceId } = setupWorkspace("swarm-focus-failed");
  const store = new SwarmStore(workspace);
  try {
    const runId = "RUN-focus-failed";
    const actor = "focus-worker";
    const artifactDir = path.join(workspace, ".swarm", "artifacts", sliceId);
    fs.mkdirSync(artifactDir, { recursive: true });
    const eventsPath = path.join(artifactDir, "worker-events-RUN-focus-failed.jsonl");
    const promptPath = path.join(artifactDir, "worker-prompt-RUN-focus-failed.md");
    const now = new Date().toISOString();
    fs.writeFileSync(promptPath, "Worker prompt for failed focus packet test.\n", "utf8");
    fs.writeFileSync(
      eventsPath,
      [
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "item_1",
            type: "command_execution",
            status: "failed",
            command: "node --input-type=module bad-probe",
            exit_code: 1,
            aggregated_output: "Error: spawn EINVAL",
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    store.insertAgentRun({
      id: runId,
      sliceId,
      role: "worker",
      entityType: "slice",
      entityId: sliceId,
      actor,
      driver: "codex",
      status: "failed",
      sessionId: "session-focus",
      attempt: 5,
      eventsPath,
      startedAt: now,
      updatedAt: now,
    });
    store.upsertHeartbeat({
      actor,
      state: "blocked",
      detail: "Last command failed",
      entityType: "slice",
      entityId: sliceId,
      timestamp: now,
    });
    store.addEvent(
      createEvent({
        actor,
        type: "worker.started",
        entityType: "slice",
        entityId: sliceId,
        payload: { runId, promptPath },
      }),
    );
  } finally {
    store.close();
  }

  const packet = JSON.parse(runSwarm(workspace, ["inspect", "run", "RUN-focus-failed", "--json"]));
  assert.deepEqual(packet.diagnosis.failureClasses.sort(), ["command_failed", "missing_structured_result", "run_failed"].sort());
  assert.equal(packet.latestSignals.lastCommand.exitCode, 1);
  assert.match(packet.latestSignals.lastCommand.outputTail, /spawn EINVAL/);
  assert.equal(packet.artifacts.prompt.exists, true);
  assert.equal(packet.artifacts.result.exists, false);
  assert.ok(packet.diagnosis.recommendedInterventions.some((item) => item.includes("Coach the agent")));
  assert.ok(packet.diagnosis.recommendedInterventions.some((item) => item.includes("same-session revive")));

  const slicePacket = JSON.parse(runSwarm(workspace, ["inspect", "slice", sliceId, "--json"]));
  assert.equal(slicePacket.kind, "slice_focus");
  assert.equal(slicePacket.latestRunFocus.run.id, "RUN-focus-failed");
  assert.ok(slicePacket.diagnosis.recommendedInterventions.some((item) => item.includes("high-retry")));
});

test("inspect run finds live event stream from idle-timeout event payload", () => {
  const { workspace, sliceId } = setupWorkspace("swarm-focus-running-timeout");
  const store = new SwarmStore(workspace);
  try {
    const runId = "RUN-focus-running-timeout";
    const actor = "focus-worker";
    const artifactDir = path.join(workspace, ".swarm", "artifacts", sliceId);
    fs.mkdirSync(artifactDir, { recursive: true });
    const eventsPath = path.join(artifactDir, "worker-events.jsonl");
    const promptPath = path.join(artifactDir, "worker-prompt-RUN-focus-running-timeout.md");
    const now = new Date().toISOString();
    fs.writeFileSync(promptPath, "Worker prompt for running timeout focus packet test.\n", "utf8");
    fs.writeFileSync(
      eventsPath,
      [
        JSON.stringify({ type: "thread.started", thread_id: "thread-focus-running-timeout" }),
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "item_1",
            type: "command_execution",
            status: "completed",
            command: "npm run test",
            exit_code: 0,
            aggregated_output: "tests 3 pass 3",
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    store.updateSliceStatus(sliceId, "implementing");
    store.insertAgentRun({
      id: runId,
      sliceId,
      role: "worker",
      entityType: "slice",
      entityId: sliceId,
      actor,
      driver: "codex",
      status: "running",
      attempt: 1,
      startedAt: now,
      updatedAt: now,
    });
    store.upsertHeartbeat({
      actor,
      state: "blocked",
      detail: "Agent child process produced no output for 300s; terminating for supervised recovery.",
      entityType: "slice",
      entityId: sliceId,
      timestamp: now,
    });
    store.addEvent(
      createEvent({
        actor,
        type: "worker.child_idle_timeout",
        entityType: "slice",
        entityId: sliceId,
        payload: { runId, jsonlPath: eventsPath, idleTimeoutMs: 300000 },
      }),
    );
  } finally {
    store.close();
  }

  const packet = JSON.parse(runSwarm(workspace, ["inspect", "run", "RUN-focus-running-timeout", "--json"]));
  assert.equal(packet.eventStream.exists, true);
  assert.equal(packet.artifacts.events.exists, true);
  assert.equal(packet.eventStream.lineCount, 2);
  assert.equal(packet.latestSignals.lastCommand.exitCode, 0);
  assert.ok(packet.diagnosis.failureClasses.includes("child_idle_timeout"));
  assert.ok(!packet.diagnosis.failureClasses.includes("no_event_stream"));

  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "40"]));
  assert.equal(snapshot.focusQueue[0].reason, "child_idle_timeout");
  assert.equal(snapshot.focusQueue[0].latestRun.eventStreamExists, true);
});

test("observe exposes run-level focus for quiet overseer before first action", () => {
  const { workspace } = setupWorkspace("swarm-focus-quiet-overseer");
  const store = new SwarmStore(workspace);
  try {
    const runId = "RUN-quiet-overseer";
    const actor = "live-overseer";
    const artifactDir = path.join(workspace, ".swarm", "artifacts", "scenario-focus");
    fs.mkdirSync(artifactDir, { recursive: true });
    const eventsPath = path.join(artifactDir, "overseer-events-RUN-quiet-overseer.jsonl");
    const promptPath = path.join(artifactDir, "overseer-prompt-RUN-quiet-overseer.md");
    const startedAt = new Date(Date.now() - 180_000).toISOString();
    fs.writeFileSync(promptPath, "Overseer prompt for quiet pre-action focus packet test.\n", "utf8");
    fs.writeFileSync(
      eventsPath,
      [JSON.stringify({ type: "thread.started" }), JSON.stringify({ type: "turn.started" })].join("\n") + "\n",
      "utf8",
    );
    store.insertAgentRun({
      id: runId,
      sliceId: "scenario:focus",
      role: "overseer",
      entityType: "harness",
      entityId: "scenario:focus",
      actor,
      driver: "codex",
      status: "running",
      attempt: 1,
      eventsPath,
      startedAt,
      updatedAt: startedAt,
    });
    store.upsertHeartbeat({
      actor,
      state: "thinking",
      detail: "Thinking (turn.started)",
      entityType: "harness",
      entityId: "scenario:focus",
      timestamp: startedAt,
    });
    store.addEvent(
      createEvent({
        actor,
        type: "overseer.started",
        entityType: "harness",
        entityId: "scenario:focus",
        payload: { runId, promptPath, eventsPath },
      }),
    );
  } finally {
    store.close();
  }

  const packet = JSON.parse(runSwarm(workspace, ["inspect", "run", "RUN-quiet-overseer", "--json"]));
  assert.equal(packet.eventStream.exists, true);
  assert.equal(packet.eventStream.lineCount, 2);
  assert.ok(packet.diagnosis.failureClasses.includes("quiet_before_first_action"));

  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "40"]));
  assert.equal(snapshot.focusQueue.length, 0);
  assert.equal(snapshot.agentFocusQueue[0].runId, "RUN-quiet-overseer");
  assert.equal(snapshot.agentFocusQueue[0].reason, "quiet_before_first_action");
  assert.match(snapshot.agentFocusQueue[0].recommendedInterventions[0], /Inspect the prompt/);
});

function setupWorkspace(name) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  const target = path.join(workspace, "target");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(
    path.join(target, "package.json"),
    JSON.stringify({ name: "invoice-api-fixture", version: "0.1.0", type: "module", scripts: { test: "node --test" } }, null, 2),
    "utf8",
  );
  fs.mkdirSync(path.join(target, "src"), { recursive: true });
  fs.mkdirSync(path.join(target, "test"), { recursive: true });
  fs.writeFileSync(
    path.join(target, "src", "invoices.js"),
    `const invoices = [
  { id: "INV-1001", customerId: "CUST-1", status: "open", totalCents: 12500 },
  { id: "INV-1002", customerId: "CUST-1", status: "paid", totalCents: 9900 },
  { id: "INV-1003", customerId: "CUST-2", status: "open", totalCents: 4500 },
];

export function listInvoices() {
  return invoices;
}

export function getInvoiceSummary() {
  return {
    count: invoices.length,
  };
}
`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(target, "test", "invoices.test.js"),
    `import test from "node:test";
import assert from "node:assert/strict";
import { getInvoiceSummary, listInvoices } from "../src/invoices.js";

test("lists seeded invoices", () => {
  assert.equal(listInvoices().length, 3);
});

test("returns baseline invoice count summary", () => {
  assert.deepEqual(getInvoiceSummary(), { count: 3 });
});
`,
    "utf8",
  );

  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["target", "init", target]);

  const store = new SwarmStore(workspace);
  const now = new Date().toISOString();
  const sliceId = "SLICE-focus";
  try {
    const targetRecord = store.listTargets()[0];
    store.insertLane({
      id: "LANE-focus",
      name: "Focus Lane",
      purpose: "Exercise focus packet diagnostics",
      focusLabels: ["focus"],
      targetId: targetRecord.id,
      orchestrator: "focus-overseer",
      worktree: target,
      state: "active",
      createdAt: now,
      updatedAt: now,
    });
    store.insertSlice({
      id: sliceId,
      laneId: "LANE-focus",
      targetId: targetRecord.id,
      title: "Implement focus diagnostic slice",
      status: "ready",
      sourceRefs: [{ adapterId: "file", kind: "markdown", uri: path.join(target, "spec.md"), title: "Focus Spec" }],
      frAcRefs: ["AC-INV-001.1", "AC-INV-001.2"],
      deliveryQuestion: "Can the worker produce diagnosable invoice evidence?",
      workPackageType: "diagnostic",
      minimumMeaningfulOutcome: "removes_blocker",
      scope: ["Create diagnosable focus packet evidence for invoice listing behavior."],
      outOfScope: ["Production behavior."],
      expectedEvidence: ["Worker result and event stream."],
      unblockTargets: [],
      verificationRequirements: ["Inspect focus packet."],
      createdAt: now,
      updatedAt: now,
    });
    store.insertLease({
      id: "LEASE-focus",
      frAcRef: "AC-INV-001.1",
      sliceId,
      laneId: "LANE-focus",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    store.insertLease({
      id: "LEASE-focus-2",
      frAcRef: "AC-INV-001.2",
      sliceId,
      laneId: "LANE-focus",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  } finally {
    store.close();
  }

  return { workspace, sliceId };
}

function runSwarm(workspace, args, env = {}) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}
