import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "dist", "cli.js");

test("live-agent smoke is exposed through the built swarm CLI", () => {
  const help = execFileSync(process.execPath, [cli, "smoke", "live-agent", "--help"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.match(help, /reset/);
  assert.match(help, /run/);
  assert.match(help, /full/);
});

test("live-agent smoke package scripts use the built CLI boundary", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

  assert.equal(packageJson.scripts.swarm, "npm run build --silent && node dist/cli.js");
  assert.equal(packageJson.scripts["swarm:dev"], "tsx src/cli.ts");
  assert.equal(packageJson.scripts["demo:live-agent:reset"], "npm run build && node dist/cli.js smoke live-agent reset");
  assert.equal(packageJson.scripts["demo:live-agent:run"], "npm run build && node dist/cli.js smoke live-agent run");
  assert.equal(packageJson.scripts["demo:live-agent:full"], "npm run build && node dist/cli.js smoke live-agent full");
  assert.equal(packageJson.scripts["smoke:live-agent:full"], "npm run build && node dist/cli.js smoke live-agent full --reset");
  assert.doesNotMatch(packageJson.scripts["smoke:live-agent:full"], /scripts[\\/]run-live-agent-demo\.mjs/);
});

