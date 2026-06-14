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

test("claude reviewer runs with normal configured tool access and applies the outcome", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-claude-reviewer-${process.pid}`);
  const target = path.join(workspace, "invoice-api");
  const fakeClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-swarm-fake-claude-reviewer-"));
  const fakeClaudeScript = path.join(fakeClaudeDir, "fake-claude-reviewer.mjs");
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(template, target, { recursive: true });
  writeFakeClaudeReviewer(fakeClaudeScript);
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

  // Implement first with the fixture worker so there is something to review.
  runSwarm(workspace, ["run", sliceId, "--driver", "fixture", "--actor", "fixture-worker"]);

  const reviewOutput = runSwarm(workspace, ["review", sliceId, "--driver", "claude", "--actor", "claude-reviewer"], env);
  assert.match(reviewOutput, /Review accepted for/);

  const store = new SwarmStore(workspace);
  try {
    const run = store.listAgentRuns().find((item) => item.actor === "claude-reviewer");
    assert.equal(run?.status, "completed");
    assert.equal(run?.driver, "claude");
    assert.ok(run?.resultPath, "review run should have a result path");

    const evidence = store.listEvidence(sliceId).find((item) => item.kind === "review_result");
    assert.ok(evidence);
    const reviewResult = JSON.parse(fs.readFileSync(run.resultPath, "utf8"));
    assert.equal(reviewResult.status, "accepted");

    const reviewerEvents = store
      .listEvents()
      .filter((item) => item.type === "reviewer.agent_event" && item.actor === "claude-reviewer");
    assert.ok(reviewerEvents.length >= 1);
    assert.ok(reviewerEvents.every((event) => event.payload.driver === "claude"));

    const completed = store
      .listEvents()
      .find((item) => item.type === "review.completed" && item.actor === "claude-reviewer");
    assert.equal(completed?.payload.driver, "claude");

    const slice = store.listSlices().find((item) => item.id === sliceId);
    assert.ok(["accepted", "ready_for_review", "verifying", "implemented"].includes(slice?.status));
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

function writeFakeClaudeReviewer(scriptPath) {
  fs.writeFileSync(
    scriptPath,
    `const args = process.argv.slice(2);
const session = "fake-claude-reviewer-session";
if (!args.includes("-p") || !args.includes("--json-schema")) {
  console.error("fake-claude-reviewer: expected -p and --json-schema in args");
  process.exit(2);
}
if (args[args.indexOf("--permission-mode") + 1] !== "acceptEdits") {
  console.error("fake-claude-reviewer: expected --permission-mode acceptEdits for normal reviewer tool access");
  process.exit(3);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: session, model: "fake-claude" }));
await sleep(150);
console.log(JSON.stringify({ type: "assistant", session_id: session, message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: { file_path: "src/app.js" } }] } }));
await sleep(150);
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: session,
  total_cost_usd: 0.03,
  result: "",
  structured_output: {
    status: "accepted",
    summary: "fixture work satisfies the in-scope FR/ACs",
    frAcFindings: [
      { ref: "AC-INV-001.1", status: "passed", evidence: ["fixture evidence"], finding: "covered" },
      { ref: "AC-INV-001.2", status: "passed", evidence: ["fixture evidence"], finding: "covered" },
      { ref: "AC-INV-001.3", status: "passed", evidence: ["fixture evidence"], finding: "covered" }
    ],
    testAssessment: "fixture tests present",
    sourceMutationDetected: false,
    stubOrHardcodeRisk: "none",
    requiredFixes: [],
    escalations: [],
    recommendation: "accept"
  }
}));
`,
    "utf8",
  );
}
