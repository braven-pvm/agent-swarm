import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("web observability demo proves browser-facing lifecycle visibility", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-web-observability-${process.pid}`);
  const output = execFileSync(process.execPath, [
    path.join(repoRoot, "scripts", "run-web-observability-demo.mjs"),
    "--driver",
    "fixture",
    "--workspace",
    workspace,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const summary = JSON.parse(output);

  assert.equal(summary.driver, "fixture");
  assert.equal(summary.runMode, "fixture");
  assert.equal(summary.counts.targets, 2);
  assert.equal(summary.counts.sources, 3);
  assert.equal(summary.counts.domains, 3);
  assert.ok(summary.counts.lanes >= 5);
  assert.ok(summary.counts.slices >= 5);
  assert.ok(summary.counts.agentRuns >= 6);
  assert.ok(summary.counts.checkpoints >= 5);
  assert.ok(summary.counts.activeEscalations >= 1);
  assert.ok(summary.counts.graphNodes > 0);
  assert.ok(summary.counts.graphEdges > 0);
  assert.ok(summary.counts.opsTimelineItems > 0);

  assert.deepEqual(summary.lifecycleAssertions, {
    hasMultipleDomains: true,
    dashboardBlockedBeforeBackend: true,
    backendAcceptedBeforeDashboard: true,
    hasWorkerAndVerifierRuns: true,
    hasRecoveryPath: true,
    hasVisibleBlocker: true,
    hasRoleCheckpoints: true,
    reportShowsFrAcCoverage: true,
    graphConnectsLifecycle: true,
    timelineShowsRecovery: true,
  });

  assert.deepEqual(summary.webAssertions, {
    htmlHasTabs: true,
    htmlHasRenderedDetailViews: true,
    appJsCompiles: true,
    browserSmokeTabsSwitch: true,
    browserSmokeSourceViewSwitches: true,
    browserSmokeSearchRuns: true,
    apiSnapshotShowsLifecycle: true,
    apiSnapshotShowsRunMode: true,
    apiSearchFindsBackendSummary: true,
    apiSourceRendersDashboardMarkdown: true,
    apiReportRendersDashboardCoverage: true,
    apiGraphHasDomainAndEvidence: true,
  });

  for (const artifact of Object.values(summary.artifacts)) {
    assert.ok(fs.existsSync(artifact), `artifact should exist: ${artifact}`);
  }

  const browserSmoke = JSON.parse(fs.readFileSync(summary.artifacts.browserSmoke, "utf8"));
  assert.match(browserSmoke.searchStatus, /match\(es\) for "summary"/);

  const dashboardReport = fs.readFileSync(summary.artifacts.report, "utf8");
  assert.match(dashboardReport, /# Slice Report:/);
  assert.match(dashboardReport, /AC-UI-INV-001\.1: passed/);
});
