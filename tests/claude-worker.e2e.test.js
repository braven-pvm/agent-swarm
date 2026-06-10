import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SwarmStore } from "../dist/storage.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "dist", "cli.js");
const template = path.join(repoRoot, "fixtures", "templates", "invoice-api");

test("claude driver runs a worker end-to-end with structured output", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-claude-worker-${process.pid}`);
  const target = path.join(workspace, "invoice-api");
  const fakeClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-swarm-fake-claude-"));
  const fakeClaudeScript = path.join(fakeClaudeDir, "fake-claude.mjs");
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(template, target, { recursive: true });
  writeFakeClaude(fakeClaudeScript);

  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["target", "init", target]);
  runSwarm(workspace, ["sources", "add-file", path.join(target, "specs", "invoice-api.md")]);
  const pullOutput = runSwarm(workspace, [
    "slices", "pull", "--target", "invoice-api", "--source", "invoice-api.md", "--batch-size", "3",
  ]);
  const sliceId = /Created slice (SLICE-[a-f0-9]+)/i.exec(pullOutput)?.[1];
  assert.ok(sliceId);

  const runOutput = runSwarm(workspace, ["run", sliceId, "--driver", "claude", "--actor", "claude-worker"], {
    SWARM_CLAUDE_COMMAND: process.execPath,
    SWARM_CLAUDE_ARGS: JSON.stringify([fakeClaudeScript]),
  });
  assert.match(runOutput, /Worker completed/);

  const store = new SwarmStore(workspace);
  try {
    const run = store.listAgentRuns().find((item) => item.actor === "claude-worker");
    assert.equal(run?.status, "completed");
    assert.equal(run?.driver, "claude");
    assert.equal(run?.sessionId, "fake-claude-session");

    const agentEvents = store
      .listEvents()
      .filter((item) => item.type === "worker.agent_event" && item.actor === "claude-worker");
    assert.ok(agentEvents.length >= 3);
    assert.ok(agentEvents.every((event) => event.payload.driver === "claude"));
    assert.ok(agentEvents.some((event) => event.payload.agentEventType === "system"));

    const resultPath = run.resultPath;
    assert.ok(resultPath && fs.existsSync(resultPath));
    const workerResult = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    assert.equal(workerResult.status, "passed");
    assert.equal(workerResult.frAcCoverage.length, 3);

    const evidence = store.listEvidence(sliceId).find((item) => item.kind === "worker_result");
    assert.ok(evidence);

    const completed = store
      .listEvents()
      .find((item) => item.type === "worker.completed" && item.actor === "claude-worker");
    assert.equal(completed?.payload.driver, "claude");
    assert.equal(completed?.payload.costUsd, 0.05);

    const slice = store.listSlices().find((item) => item.id === sliceId);
    assert.equal(slice?.status, "implemented");
  } finally {
    store.close();
  }
});

test("claude driver revives a run by captured session id", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-claude-revive-${process.pid}`);
  const target = path.join(workspace, "invoice-api");
  const fakeClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-swarm-fake-claude-revive-"));
  const fakeClaudeScript = path.join(fakeClaudeDir, "fake-claude.mjs");
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(template, target, { recursive: true });
  writeFakeClaude(fakeClaudeScript);
  const env = {
    SWARM_CLAUDE_COMMAND: process.execPath,
    SWARM_CLAUDE_ARGS: JSON.stringify([fakeClaudeScript]),
  };

  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["target", "init", target]);
  runSwarm(workspace, ["sources", "add-file", path.join(target, "specs", "invoice-api.md")]);
  const pullOutput = runSwarm(workspace, [
    "slices", "pull", "--target", "invoice-api", "--source", "invoice-api.md", "--batch-size", "3",
  ]);
  const sliceId = /Created slice (SLICE-[a-f0-9]+)/i.exec(pullOutput)?.[1];
  assert.ok(sliceId);
  runSwarm(workspace, ["run", sliceId, "--driver", "claude", "--actor", "claude-worker"], env);

  let firstRunId;
  {
    const store = new SwarmStore(workspace);
    try {
      const run = store.listAgentRuns().find((item) => item.actor === "claude-worker");
      assert.ok(run);
      assert.equal(run.sessionId, "fake-claude-session");
      firstRunId = run.id;
    } finally {
      store.close();
    }
  }

  const reviveOutput = runSwarm(workspace, ["recovery", "revive", firstRunId], env);
  assert.match(reviveOutput, /Revived/);

  const store = new SwarmStore(workspace);
  try {
    const runs = store.listAgentRuns().filter((item) => item.actor === "claude-worker");
    assert.equal(runs.length, 2);
    const revived = runs.find((item) => item.id !== firstRunId);
    assert.equal(revived?.status, "completed");
    assert.equal(revived?.driver, "claude");
    assert.ok(revived?.resultPath);
    const revivedResult = JSON.parse(fs.readFileSync(revived.resultPath, "utf8"));
    assert.equal(revivedResult.summary, "fake claude revive completed");
  } finally {
    store.close();
  }
});

test("run rejects unknown drivers and resolves the protocol default driver", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-driver-resolution-${process.pid}`);
  const target = path.join(workspace, "invoice-api");
  const fakeClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-swarm-fake-claude-default-"));
  const fakeClaudeScript = path.join(fakeClaudeDir, "fake-claude.mjs");
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(template, target, { recursive: true });
  writeFakeClaude(fakeClaudeScript);

  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["target", "init", target]);
  fs.writeFileSync(
    path.join(target, ".swarm", "protocol.yaml"),
    `protocol:
  workers:
    defaultDriver: claude
`,
    "utf8",
  );
  runSwarm(workspace, ["sources", "add-file", path.join(target, "specs", "invoice-api.md")]);
  const pullOutput = runSwarm(workspace, [
    "slices", "pull", "--target", "invoice-api", "--source", "invoice-api.md", "--batch-size", "3",
  ]);
  const sliceId = /Created slice (SLICE-[a-f0-9]+)/i.exec(pullOutput)?.[1];
  assert.ok(sliceId);

  let threw = false;
  try {
    runSwarm(workspace, ["run", sliceId, "--driver", "bogus", "--actor", "driver-check"]);
  } catch (error) {
    threw = true;
    assert.match(String(error.stderr ?? error.message), /Invalid worker driver/);
  }
  assert.ok(threw);

  const runOutput = runSwarm(workspace, ["run", sliceId, "--actor", "default-driver-worker"], {
    SWARM_CLAUDE_COMMAND: process.execPath,
    SWARM_CLAUDE_ARGS: JSON.stringify([fakeClaudeScript]),
  });
  assert.match(runOutput, /Worker completed/);

  const store = new SwarmStore(workspace);
  try {
    const run = store.listAgentRuns().find((item) => item.actor === "default-driver-worker");
    assert.equal(run?.driver, "claude");
  } finally {
    store.close();
  }
});

function runSwarm(workspace, args, extraEnv = {}) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
  });
}

function writeFakeClaude(scriptPath) {
  fs.writeFileSync(
    scriptPath,
    `const args = process.argv.slice(2);
const session = "fake-claude-session";
const isResume = args.includes("--resume");
if (!args.includes("-p") || !args.includes("--json-schema")) {
  console.error("fake-claude: expected -p and --json-schema in args");
  process.exit(2);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: session, model: "fake-claude", tools: ["Edit", "Bash", "StructuredOutput"] }));
await sleep(300);
console.log(JSON.stringify({ type: "assistant", session_id: session, message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/app.js" } }] } }));
await sleep(300);
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: session,
  num_turns: 2,
  total_cost_usd: 0.05,
  result: "",
  structured_output: {
    status: "passed",
    summary: isResume ? "fake claude revive completed" : "fake claude completed",
    changedFiles: ["src/app.js"],
    commandsRun: ["npm test"],
    testsRun: ["npm test"],
    frAcCoverage: [
      { ref: "AC-INV-001.1", status: "covered", evidence: "fake evidence" },
      { ref: "AC-INV-001.2", status: "covered", evidence: "fake evidence" },
      { ref: "AC-INV-001.3", status: "covered", evidence: "fake evidence" }
    ],
    risks: [],
    nextRecommendation: "continue"
  }
}));
`,
    "utf8",
  );
}
