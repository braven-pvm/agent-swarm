import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "dist", "cli.js");
const resetScript = path.join(repoRoot, "scripts", "reset-live-agent-smoke.mjs");
const workspace = path.join(repoRoot, ".swarm-demo", "live-agent-smoke");

test("live agent smoke reset creates a labeled resettable workspace", () => {
  const output = execFileSync(process.execPath, [resetScript], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const summary = JSON.parse(output);
  assert.equal(summary.workspace, workspace);
  assert.equal(summary.runMode, "live-agent-smoke");
  assert.equal(summary.counts.targets, 2);
  assert.equal(summary.counts.sources, 3);
  assert.equal(summary.counts.slices, 0);
  assert.ok(fs.existsSync(summary.manifest));

  const manifest = JSON.parse(fs.readFileSync(summary.manifest, "utf8"));
  assert.equal(manifest.scenarioId, "live-agent-smoke");
  assert.equal(manifest.runMode, "live-agent-smoke");
  assert.equal(manifest.phase, "phase-1-reset-and-run-mode");
  assert.equal(manifest.targets.length, 2);
  assert.equal(manifest.sources.length, 3);
  assert.ok(manifest.fullProductMode.productSpec.endsWith("live-smoke-invoice-dashboard-product-spec.md"));

  const snapshot = JSON.parse(runSwarm(["observe", "--events", "20"]));
  assert.equal(snapshot.runMode, "live-agent-smoke");
  assert.equal(snapshot.targets.length, 2);
  assert.equal(snapshot.sources.length, 3);
  assert.ok(snapshot.sources.some((source) => source.title === "Live Smoke Product Spec: Invoice Operations Dashboard"));
  assert.ok(snapshot.domains.some((domain) => domain.domain === "Invoice Product"));
  assert.ok(snapshot.domains.some((domain) => domain.domain === "Invoice Backend"));
  assert.ok(snapshot.domains.some((domain) => domain.domain === "Invoice Dashboard"));

  const status = runSwarm(["status"]);
  assert.match(status, /Run mode: live-agent-smoke/);
});

test("live agent smoke reset refuses unsafe workspace overrides", () => {
  assert.throws(
    () =>
      execFileSync(process.execPath, [resetScript, "--workspace", repoRoot], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    /Refusing to reset workspace outside approved live smoke root/,
  );
});

function runSwarm(args) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
