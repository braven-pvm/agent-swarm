import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "dist", "cli.js");
const resetScript = path.join(repoRoot, "scripts", "reset-live-agent-smoke.mjs");

test("live agent smoke reset creates a labeled resettable workspace", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-live-agent-smoke-reset-${process.pid}-${Date.now()}`);
  const output = execFileSync(process.execPath, [resetScript, "--workspace", workspace, "--stop-related-processes"], {
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
  assert.ok(Array.isArray(summary.stoppedProcesses));
  assert.equal(summary.recovery.childIdleTimeoutSeconds, 300);
  assert.ok(fs.existsSync(summary.manifest));

  const manifest = JSON.parse(fs.readFileSync(summary.manifest, "utf8"));
  assert.equal(manifest.scenarioId, "live-agent-smoke");
  assert.equal(manifest.runMode, "live-agent-smoke");
  assert.equal(manifest.phase, "phase-1-reset-and-run-mode");
  assert.equal(manifest.targets.length, 2);
  assert.equal(manifest.sources.length, 3);
  assert.equal(manifest.fullProductMode.plannedCommand, "npm run smoke:live-agent:full");
  assert.ok(manifest.fullProductMode.productSpec.endsWith("live-smoke-invoice-dashboard-product-spec.md"));
  assert.equal(manifest.fullProductMode.maxTurns, 80);
  assert.equal(manifest.fullProductMode.maxSlices, 20);
  assert.equal(manifest.fullProductMode.maxAgentRuns, 150);
  assert.equal(manifest.fullProductMode.maxRuntimeMinutes, 120);
  assert.equal(manifest.fullProductMode.childIdleTimeoutSeconds, 300);
  assert.equal(manifest.commands.fullProduct, "npm run demo:live-agent:full");
  assert.equal(manifest.commands.resetAndFullProduct, "npm run smoke:live-agent:full");

  const snapshot = JSON.parse(runSwarm(["observe", "--events", "20"], workspace));
  assert.equal(snapshot.runMode, "live-agent-smoke");
  assert.equal(snapshot.targets.length, 2);
  assert.equal(snapshot.sources.length, 3);
  assert.ok(snapshot.sources.some((source) => source.title === "Live Smoke Product Spec: Invoice Operations Dashboard"));
  assert.ok(snapshot.domains.some((domain) => domain.domain === "Invoice Product"));
  assert.ok(snapshot.domains.some((domain) => domain.domain === "Invoice Backend"));
  assert.ok(snapshot.domains.some((domain) => domain.domain === "Invoice Dashboard"));

  const productSpec = path.join(workspace, "source-specs", "live-smoke-invoice-dashboard-product-spec.md");
  const dashboardPackage = JSON.parse(fs.readFileSync(path.join(workspace, "invoice-dashboard", "package.json"), "utf8"));
  const backendProtocol = YAML.parse(fs.readFileSync(path.join(workspace, "invoice-api", ".swarm", "protocol.yaml"), "utf8"));
  const dashboardProtocol = YAML.parse(fs.readFileSync(path.join(workspace, "invoice-dashboard", ".swarm", "protocol.yaml"), "utf8"));
  assert.ok(fs.existsSync(productSpec));
  assert.equal(typeof dashboardPackage.scripts.test, "string");
  assert.equal(dashboardPackage.scripts.start, undefined);
  assert.equal(backendProtocol.protocol.recovery.childIdleTimeoutSeconds, 300);
  assert.equal(dashboardProtocol.protocol.recovery.childIdleTimeoutSeconds, 300);

  const status = runSwarm(["status"], workspace);
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
    /Refusing to reset workspace outside approved live smoke root|Refusing unsafe live smoke workspace/,
  );
});

function runSwarm(args, workspace) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
