import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { SwarmStore } from "../dist/storage.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "dist", "cli.js");
const template = path.join(repoRoot, "fixtures", "templates", "invoice-api");

test("codex worker JSONL is ingested while the process is still running", async () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-streaming-${process.pid}`);
  const target = path.join(workspace, "invoice-api");
  const fakeCodexDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-swarm-fake-codex-"));
  const fakeCodexScript = path.join(fakeCodexDir, "fake-codex.mjs");
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(template, target, { recursive: true });
  writeFakeCodex(fakeCodexScript);

  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["target", "init", target]);
  runSwarm(workspace, ["sources", "add-file", path.join(target, "specs", "invoice-api.md")]);
  const pullOutput = runSwarm(workspace, [
    "slices",
    "pull",
    "--target",
    "invoice-api",
    "--source",
    "invoice-api.md",
    "--batch-size",
    "3",
  ]);
  const sliceId = /Created slice (SLICE-[a-f0-9]+)/i.exec(pullOutput)?.[1];
  assert.ok(sliceId);

  const child = spawn(process.execPath, [cli, "run", sliceId, "--driver", "codex", "--actor", "streaming-worker"], {
    cwd: workspace,
    env: {
      ...process.env,
      SWARM_CODEX_COMMAND: process.execPath,
      SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const liveState = await waitFor(() => {
    const store = new SwarmStore(workspace);
    try {
      const run = store.listAgentRuns("running").find((item) => item.actor === "streaming-worker");
      const heartbeat = store.listHeartbeats().find((item) => item.actor === "streaming-worker");
      const event = store.listEvents().find((item) => item.type === "worker.agent_event" && item.actor === "streaming-worker");
      if (run && heartbeat?.detail?.includes("thread.started") && event) return { run, heartbeat, event };
      return undefined;
    } finally {
      store.close();
    }
  });

  assert.equal(liveState.run.status, "running");
  assert.equal(liveState.heartbeat.state, "thinking");
  assert.equal(liveState.event.payload.agentEventType, "thread.started");

  const exitCode = await waitForExit(child);
  assert.equal(exitCode, 0);
  const store = new SwarmStore(workspace);
  try {
    const completedRun = store.listAgentRuns().find((item) => item.actor === "streaming-worker");
    const events = store.listEvents().filter((item) => item.type === "worker.agent_event" && item.actor === "streaming-worker");
    assert.equal(completedRun?.status, "completed");
    assert.equal(completedRun?.sessionId, "fake-thread");
    assert.ok(events.length >= 3);
  } finally {
    store.close();
  }
});

test("codex worker recovers from a valid result artifact when the child process stays open", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-artifact-recovery-hung-child-${process.pid}-${Date.now()}`);
  const target = path.join(workspace, "invoice-api");
  const fakeCodexDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-swarm-fake-codex-"));
  const fakeCodexScript = path.join(fakeCodexDir, "fake-codex-hung-after-result.mjs");
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(template, target, { recursive: true });
  writeFakeCodexHangsAfterResult(fakeCodexScript);

  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["target", "init", target]);
  runSwarm(workspace, ["sources", "add-file", path.join(target, "specs", "invoice-api.md")]);
  const pullOutput = runSwarm(workspace, [
    "slices",
    "pull",
    "--target",
    "invoice-api",
    "--source",
    "invoice-api.md",
    "--batch-size",
    "3",
  ]);
  const sliceId = /Created slice (SLICE-[a-f0-9]+)/i.exec(pullOutput)?.[1];
  assert.ok(sliceId);

  const runOutput = execFileSync(process.execPath, [cli, "run", sliceId, "--driver", "codex", "--actor", "artifact-recovery-worker"], {
    cwd: workspace,
    env: {
      ...process.env,
      SWARM_CODEX_COMMAND: process.execPath,
      SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
      SWARM_RESULT_ARTIFACT_RECOVERY_QUIET_SECONDS: "1",
      SWARM_AGENT_IDLE_TIMEOUT_SECONDS: "30",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000,
  });
  assert.match(runOutput, /Worker completed/);

  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "100"]));
  const completedRun = snapshot.agentRuns.find((item) => item.actor === "artifact-recovery-worker");
  assert.equal(completedRun?.status, "completed");
  const recoveryEvent = snapshot.recentEvents.find(
    (event) => event.type === "worker.result_artifact_recovered" && event.actor === "artifact-recovery-worker",
  );
  assert.ok(recoveryEvent);
  assert.equal(recoveryEvent.payload.resultPath, completedRun.resultPath);
  const completedEvent = snapshot.recentEvents.find(
    (event) => event.type === "worker.completed" && event.actor === "artifact-recovery-worker",
  );
  assert.equal(completedEvent.payload.exitCode, null);
  assert.equal(completedEvent.payload.resultArtifactRecovered, true);
  assert.equal(completedEvent.payload.resultArtifactRecoveryTriggered, true);
  assert.match(completedEvent.payload.recoveryReason, /did not produce a close status/);
});

function runSwarm(workspace, args) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function writeFakeCodex(scriptPath) {
  fs.writeFileSync(
    scriptPath,
    `import fs from "node:fs";
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
console.log(JSON.stringify({ type: "thread.started", thread_id: "fake-thread" }));
await sleep(750);
console.log(JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "npm test" } }));
await sleep(750);
if (outputPath) {
  fs.writeFileSync(outputPath, JSON.stringify({
    status: "passed",
    summary: "fake codex completed",
    changedFiles: [],
    commandsRun: ["npm test"],
    testsRun: ["npm test"],
    frAcCoverage: [
      { ref: "AC-INV-001.1", status: "covered", evidence: "fake evidence" },
      { ref: "AC-INV-001.2", status: "covered", evidence: "fake evidence" },
      { ref: "AC-INV-001.3", status: "covered", evidence: "fake evidence" }
    ],
    risks: [],
    nextRecommendation: "continue"
  }) + "\\n", "utf8");
}
console.log(JSON.stringify({ type: "turn.completed" }));
`,
    "utf8",
  );
}

function writeFakeCodexHangsAfterResult(scriptPath) {
  fs.writeFileSync(
    scriptPath,
    `import fs from "node:fs";
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
console.log(JSON.stringify({ type: "thread.started", thread_id: "fake-hung-thread" }));
if (outputPath) {
  fs.writeFileSync(outputPath, JSON.stringify({
    status: "passed",
    summary: "fake codex wrote a valid result before hanging",
    changedFiles: [],
    commandsRun: ["npm test"],
    testsRun: ["npm test"],
    frAcCoverage: [
      { ref: "AC-INV-001.1", status: "covered", evidence: "fake evidence" },
      { ref: "AC-INV-001.2", status: "covered", evidence: "fake evidence" },
      { ref: "AC-INV-001.3", status: "covered", evidence: "fake evidence" }
    ],
    risks: [],
    nextRecommendation: "continue"
  }) + "\\n", "utf8");
}
setInterval(() => {}, 1000);
`,
    "utf8",
  );
}

async function waitFor(callback, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = callback();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for condition");
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
}
