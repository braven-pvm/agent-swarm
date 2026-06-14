import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "dist", "cli.js");

function runCheck(args, extraEnv = {}) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return { code: error.status ?? 1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
  }
}

test("check reports a launchable driver and its version", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-check-"));
  const stub = path.join(dir, "fake-version.mjs");
  fs.writeFileSync(stub, `if (process.argv.includes("--version")) { console.log("fake-codex 9.9.9"); process.exit(0); } process.exit(7);`, "utf8");

  const result = runCheck(["check", "codex"], {
    SWARM_CODEX_COMMAND: process.execPath,
    SWARM_CODEX_ARGS: JSON.stringify([stub]),
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /launchable/i);
  assert.match(result.stdout, /fake-codex 9\.9\.9/);
});

test("check reports a missing driver as not launchable with non-zero exit", () => {
  const result = runCheck(["check", "codex"], {
    SWARM_CODEX_COMMAND: "definitely-not-a-real-binary-xyz",
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /not installed|not on PATH|not launchable|ENOENT/i);
});
