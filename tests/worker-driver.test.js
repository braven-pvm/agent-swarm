import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getWorkerDriver, workerDriverIds } from "../dist/worker-driver.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "swarm-worker-driver-"));
}

function writeSchema(dir) {
  const schemaPath = path.join(dir, "worker-result.schema.json");
  fs.writeFileSync(
    schemaPath,
    JSON.stringify({
      type: "object",
      required: ["status", "summary"],
      properties: { status: { type: "string" }, summary: { type: "string" } },
    }),
    "utf8",
  );
  return schemaPath;
}

function baseSpec(dir) {
  return {
    prompt: "Implement the slice",
    targetPath: path.join(dir, "target"),
    schemaPath: writeSchema(dir),
    resultPath: path.join(dir, "worker-result.json"),
    driverConfig: {},
  };
}

test("registry exposes codex and claude drivers", () => {
  assert.deepEqual(workerDriverIds().sort(), ["claude", "codex"]);
  assert.equal(getWorkerDriver("codex")?.capabilities.resume, true);
  assert.equal(getWorkerDriver("claude")?.capabilities.resume, true);
  assert.equal(getWorkerDriver("unknown"), undefined);
});

test("codex adapter builds the current fresh-run invocation", () => {
  const dir = tempDir();
  const spec = { ...baseSpec(dir), model: "gpt-5.3-codex" };
  const invocation = getWorkerDriver("codex").buildInvocation(spec);

  assert.equal(invocation.command, "codex");
  assert.deepEqual(invocation.args, [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "workspace-write",
    "-C",
    spec.targetPath,
    "--output-schema",
    spec.schemaPath,
    "--output-last-message",
    spec.resultPath,
    "--model",
    "gpt-5.3-codex",
    "Implement the slice",
  ]);
});

test("codex adapter builds the resume invocation", () => {
  const dir = tempDir();
  const spec = { ...baseSpec(dir), resumeSessionId: "session-abc" };
  const invocation = getWorkerDriver("codex").buildInvocation(spec);

  assert.deepEqual(invocation.args, [
    "exec",
    "resume",
    "--json",
    "--skip-git-repo-check",
    "--output-schema",
    spec.schemaPath,
    "--output-last-message",
    spec.resultPath,
    "session-abc",
    "Implement the slice",
  ]);
});

test("codex finalize reports ok from exit code and result file presence", () => {
  const dir = tempDir();
  const spec = baseSpec(dir);
  const codex = getWorkerDriver("codex");

  const missing = codex.finalize({ exitCode: 0, stdout: "", spec });
  assert.equal(missing.ok, true);
  assert.equal(missing.structuredResultWritten, false);

  fs.writeFileSync(spec.resultPath, "{}", "utf8");
  const present = codex.finalize({ exitCode: 0, stdout: "", spec });
  assert.equal(present.structuredResultWritten, true);

  const failed = codex.finalize({ exitCode: 1, stdout: "", spec });
  assert.equal(failed.ok, false);
});

test("driver command honors SWARM_<DRIVER>_COMMAND and SWARM_<DRIVER>_ARGS", () => {
  const dir = tempDir();
  process.env.SWARM_CODEX_COMMAND = "node";
  process.env.SWARM_CODEX_ARGS = JSON.stringify(["fake-codex.mjs"]);
  try {
    const invocation = getWorkerDriver("codex").buildInvocation(baseSpec(dir));
    assert.equal(invocation.command, "node");
    assert.deepEqual(invocation.args.slice(0, 2), ["fake-codex.mjs", "exec"]);
  } finally {
    delete process.env.SWARM_CODEX_COMMAND;
    delete process.env.SWARM_CODEX_ARGS;
  }
});

test("claude adapter builds a fresh-run invocation with inlined schema", () => {
  const dir = tempDir();
  const spec = { ...baseSpec(dir), model: "claude-opus-4-8" };
  const invocation = getWorkerDriver("claude").buildInvocation(spec);
  const schemaJson = JSON.stringify(JSON.parse(fs.readFileSync(spec.schemaPath, "utf8")));

  assert.equal(invocation.command, "claude");
  assert.deepEqual(invocation.args, [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--json-schema",
    schemaJson,
    "--permission-mode",
    "acceptEdits",
    "--setting-sources",
    "",
    "--model",
    "claude-opus-4-8",
    "Implement the slice",
  ]);
});

test("claude adapter applies driver config and resume session", () => {
  const dir = tempDir();
  const spec = {
    ...baseSpec(dir),
    resumeSessionId: "11111111-2222-3333-4444-555555555555",
    driverConfig: { permissionMode: "bypassPermissions", allowedTools: "Edit Read Bash", maxBudgetUsd: 5 },
  };
  const args = getWorkerDriver("claude").buildInvocation(spec).args;

  assert.ok(args.includes("--resume"));
  assert.equal(args[args.indexOf("--resume") + 1], "11111111-2222-3333-4444-555555555555");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.equal(args[args.indexOf("--allowedTools") + 1], "Edit Read Bash");
  assert.equal(args[args.indexOf("--max-budget-usd") + 1], "5");
  assert.equal(args[args.length - 1], "Implement the slice");
});

test("claude finalize writes validated structured output to the result file", () => {
  const dir = tempDir();
  const spec = baseSpec(dir);
  const workerResult = {
    status: "passed",
    summary: "done",
    changedFiles: ["src/app.js"],
    commandsRun: ["npm test"],
    testsRun: ["npm test"],
    frAcCoverage: [{ ref: "AC-1", status: "covered", evidence: "test output" }],
    risks: [],
    nextRecommendation: "continue",
  };
  const stdout = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "s-1", total_cost_usd: 0.05, structured_output: workerResult }),
  ].join("\n");

  const finalization = getWorkerDriver("claude").finalize({ exitCode: 0, stdout, spec });

  assert.equal(finalization.ok, true);
  assert.equal(finalization.structuredResultWritten, true);
  assert.equal(finalization.costUsd, 0.05);
  assert.deepEqual(JSON.parse(fs.readFileSync(spec.resultPath, "utf8")), workerResult);
});

test("claude finalize fails on error results and missing structured output", () => {
  const dir = tempDir();
  const claude = getWorkerDriver("claude");

  const errorSpec = baseSpec(dir);
  const errored = claude.finalize({
    exitCode: 1,
    stdout: JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in" }),
    spec: errorSpec,
  });
  assert.equal(errored.ok, false);
  assert.match(errored.failureReason, /Not logged in/);
  assert.equal(fs.existsSync(errorSpec.resultPath), false);

  const missingSpec = baseSpec(tempDir());
  const missing = claude.finalize({
    exitCode: 0,
    stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "plain text only" }),
    spec: missingSpec,
  });
  assert.equal(missing.ok, false);
  assert.match(missing.failureReason, /structured_output/);

  const silentSpec = baseSpec(tempDir());
  const silent = claude.finalize({ exitCode: 0, stdout: "", spec: silentSpec });
  assert.equal(silent.ok, false);
  assert.match(silent.failureReason, /no result event/i);
});

test("driver args env rejects non-array JSON with a clear error", () => {
  const dir = tempDir();
  process.env.SWARM_CODEX_ARGS = JSON.stringify({ not: "an array" });
  try {
    assert.throws(() => getWorkerDriver("codex").buildInvocation(baseSpec(dir)), /SWARM_CODEX_ARGS is invalid/);
  } finally {
    delete process.env.SWARM_CODEX_ARGS;
  }
});

test("codex resume invocation includes a model override when provided", () => {
  const dir = tempDir();
  const spec = { ...baseSpec(dir), resumeSessionId: "session-abc", model: "gpt-5.3-codex" };
  const args = getWorkerDriver("codex").buildInvocation(spec).args;
  assert.equal(args[args.indexOf("--model") + 1], "gpt-5.3-codex");
  assert.deepEqual(args.slice(-2), ["session-abc", "Implement the slice"]);
});

test("claude finalize omits costUsd when total_cost_usd is absent", () => {
  const dir = tempDir();
  const spec = baseSpec(dir);
  const workerResult = {
    status: "passed",
    summary: "done",
    changedFiles: [],
    commandsRun: [],
    testsRun: [],
    frAcCoverage: [],
    risks: [],
    nextRecommendation: "continue",
  };
  const stdout = JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: workerResult });
  const finalization = getWorkerDriver("claude").finalize({ exitCode: 0, stdout, spec });
  assert.equal(finalization.ok, true);
  assert.equal(finalization.costUsd, undefined);
});

test("claude heartbeat classifier maps tool use to states", () => {
  const claude = getWorkerDriver("claude");
  const toolEvent = (name) => ({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", name, input: {} }] },
  });

  assert.equal(claude.classifyHeartbeat(toolEvent("Edit")), "editing");
  assert.equal(claude.classifyHeartbeat(toolEvent("Write")), "editing");
  assert.equal(claude.classifyHeartbeat(toolEvent("Bash")), "testing");
  assert.equal(claude.classifyHeartbeat(toolEvent("Read")), "reading");
  assert.equal(claude.classifyHeartbeat(toolEvent("Grep")), "reading");
  assert.equal(claude.classifyHeartbeat(toolEvent("StructuredOutput")), "verifying");
  assert.equal(claude.classifyHeartbeat({ type: "system", subtype: "init" }), "thinking");
  assert.equal(claude.classifyHeartbeat({ type: "result", is_error: false }), "idle");
  assert.equal(claude.classifyHeartbeat({ type: "result", is_error: true }), "blocked");
  assert.equal(claude.classifyHeartbeat({ type: "user" }), undefined);
});
