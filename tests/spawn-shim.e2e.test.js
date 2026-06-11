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

test(
  "worker dispatch can spawn a .cmd shim command (Windows shim resolution)",
  { skip: process.platform !== "win32" ? "Windows-only: .cmd shim resolution" : false },
  () => {
    const workspace = path.join(repoRoot, ".swarm-demo", `test-spawn-shim-${process.pid}-${Date.now()}`);
    const target = path.join(workspace, "invoice-api");
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-swarm-shim-"));
    const innerScript = path.join(shimDir, "fake-codex.mjs");
    const cmdShim = path.join(shimDir, "fake-codex.cmd");
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.cpSync(template, target, { recursive: true });
    writeFakeCodexNode(innerScript);
    // A real .cmd shim that forwards to node (this is what npm-installed CLIs look like on Windows).
    fs.writeFileSync(cmdShim, `@echo off\r\n"${process.execPath}" "${innerScript}" %*\r\n`, "utf8");

    runSwarm(workspace, ["init"]);
    runSwarm(workspace, ["target", "init", target]);
    runSwarm(workspace, ["sources", "add-file", path.join(target, "specs", "invoice-api.md")]);
    const pullOutput = runSwarm(workspace, [
      "slices", "pull", "--target", "invoice-api", "--source", "invoice-api.md", "--batch-size", "3",
    ]);
    const sliceId = /Created slice (SLICE-[a-f0-9]+)/.exec(pullOutput)?.[1];
    assert.ok(sliceId);

    // Point the codex command at the .cmd shim by its FULL PATH. The old child_process.spawn
    // (shell:false) cannot exec a .cmd; cross-spawn can.
    const runOutput = runSwarm(workspace, ["run", sliceId, "--driver", "codex", "--actor", "shim-worker"], {
      SWARM_CODEX_COMMAND: cmdShim,
    });
    assert.match(runOutput, /Worker completed/);

    const store = new SwarmStore(workspace);
    try {
      const run = store.listAgentRuns().find((item) => item.actor === "shim-worker");
      assert.equal(run?.status, "completed");
      assert.equal(run?.driver, "codex");
      assert.ok(run.resultPath && fs.existsSync(run.resultPath));
      const result = JSON.parse(fs.readFileSync(run.resultPath, "utf8"));
      assert.equal(result.status, "passed");
    } finally {
      store.close();
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  },
);

function runSwarm(workspace, args, extraEnv = {}) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
  });
}

function writeFakeCodexNode(scriptPath) {
  fs.writeFileSync(
    scriptPath,
    `import fs from "node:fs";
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
console.log(JSON.stringify({ type: "thread.started", thread_id: "shim-thread" }));
if (outputPath) {
  fs.writeFileSync(outputPath, JSON.stringify({
    status: "passed",
    summary: "fake codex via .cmd shim completed",
    changedFiles: [],
    commandsRun: ["npm test"],
    testsRun: ["npm test"],
    frAcCoverage: [
      { ref: "AC-INV-001.1", status: "covered", evidence: "shim evidence" },
      { ref: "AC-INV-001.2", status: "covered", evidence: "shim evidence" },
      { ref: "AC-INV-001.3", status: "covered", evidence: "shim evidence" }
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
