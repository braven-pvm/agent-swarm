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
