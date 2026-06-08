import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("observability demo exercises worker, recovery, watch, timeline, graph, and report surfaces", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-observability-${process.pid}`);
  const output = execFileSync(process.execPath, [
    path.join(repoRoot, "scripts", "run-observability-demo.mjs"),
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
  assert.equal(summary.counts.targets, 2);
  assert.equal(summary.counts.sources, 2);
  assert.ok(summary.counts.lanes >= 4);
  assert.ok(summary.counts.slices >= 4);
  assert.ok(summary.counts.agentRuns >= 6);
  assert.ok(summary.counts.graphNodes > 0);
  assert.ok(summary.counts.graphEdges > 0);
  assert.ok(summary.counts.timelineItems > 0);
  assert.deepEqual(summary.observabilityAssertions, {
    hasWorkerEvents: true,
    hasRecoveryEvents: true,
    hasRestartRun: true,
    watchAgentsMentionsRuns: true,
    watchBlockersMentionsEscalation: true,
    timelineMentionsRecovery: true,
    graphHasEvidence: true,
    reportMentionsEscalation: true,
  });
});
