import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "dist", "cli.js");

test("support triage fake-agent E2E exercises lifecycle, human verification, repair, and product readiness", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-live-agent-support-triage-fake-${process.pid}-${Date.now()}`);
  const summaryPath = path.join(workspace, "h2-fake-summary.json");
  const output = execFileSync(
    process.execPath,
    [
      cli,
      "smoke",
      "live-agent",
      "fake",
      "--reset",
      "--scenario",
      "live-agent-smoke-h2",
      "--workspace",
      workspace,
      "--summary",
      summaryPath,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 50 * 1024 * 1024,
    },
  );
  const summary = JSON.parse(output);

  assert.equal(summary.scenario, "live-agent-smoke-h2");
  assert.equal(summary.workspace, workspace);
  assert.equal(summary.phase, "phase-11c-h2-fake-agent-e2e");
  assert.equal(summary.finalOutcome, "accepted");
  assert.ok(Object.entries(summary.assertions).every(([, value]) => value === true));
  assert.equal(summary.slices.length, 3);
  assert.ok(summary.slices.some((slice) => slice.exercisedRepair));
  assert.ok(summary.slices.some((slice) => slice.humanVerifiedRefs.length > 0));
  assert.equal(summary.productReadiness.status, "passed");
  assert.equal(summary.humanActionsAfter.totals.total, 0);
  assert.ok(summary.coverage.done > 0);
  assert.equal(summary.coverage.awaitingHumanVerification, 0);

  for (const artifact of [
    summary.artifacts.summary,
    summary.artifacts.finalSnapshot,
    summary.artifacts.productReadiness,
    summary.artifacts.fakeReviewer,
  ]) {
    assert.ok(fs.existsSync(artifact), `missing artifact ${artifact}`);
  }

  const snapshot = JSON.parse(fs.readFileSync(summary.artifacts.finalSnapshot, "utf8"));
  assert.ok(snapshot.slices.filter((slice) => slice.status === "accepted").length >= 3);
  assert.ok(snapshot.recentEvents.some((event) => event.type === "review.blocked_acceptance"));
  assert.ok(snapshot.recentEvents.some((event) => event.type === "human_verification.packet_created"));
  assert.ok(snapshot.recentEvents.some((event) => event.type === "human_verification.recorded"));
  assert.ok(snapshot.recentEvents.some((event) => event.type === "verification.completed" && event.payload.passed === true));

  const manifest = JSON.parse(fs.readFileSync(path.join(workspace, "live-agent-smoke.json"), "utf8"));
  assert.equal(manifest.phase, "phase-11c-h2-fake-agent-e2e");
  assert.equal(manifest.runnerStatus, "fake_agent_e2e_passed");
});

test("support triage missing required skill blocks before fixture worker launch", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-live-agent-support-triage-missing-skill-${process.pid}-${Date.now()}`);
  runSwarm([
    "smoke",
    "live-agent",
    "reset",
    "--scenario",
    "live-agent-smoke-h2",
    "--workspace",
    workspace,
    "--stop-related-processes",
  ], repoRoot);

  const protocolPath = path.join(workspace, "support-ui", ".swarm", "protocol.yaml");
  const protocol = YAML.parse(fs.readFileSync(protocolPath, "utf8"));
  protocol.protocol.skills.roles.worker.required = ["missing-h2-required-skill"];
  fs.writeFileSync(protocolPath, YAML.stringify(protocol, { lineWidth: 0 }), "utf8");

  const pullOutput = runSwarm([
    "slices",
    "pull",
    "--target",
    "support-ui",
    "--source",
    "live-smoke-support-triage-ui-requirements.md",
    "--new-lane",
    "--lane-name",
    "H2 Missing Skill Lane",
    "--lane-purpose",
    "Prove missing required skills block before agent launch.",
    "--lane-labels",
    "support,frontend,h2,negative",
    "--batch-size",
    "3",
  ], workspace);
  const sliceId = /Created slice (SLICE-[a-f0-9]+)/i.exec(pullOutput)?.[1];
  assert.ok(sliceId);

  assert.throws(
    () => runSwarm(["run", sliceId, "--driver", "fixture", "--actor", "h2-missing-skill-worker"], workspace),
    /Missing required worker skill\(s\): missing-h2-required-skill/,
  );

  const snapshot = JSON.parse(runSwarm(["observe", "--events", "80"], workspace));
  assert.ok(!snapshot.recentEvents.some((event) => event.type === "worker.started" && event.entityId === sliceId));
  assert.ok(!snapshot.agentRuns.some((run) => run.sliceId === sliceId && run.actor === "h2-missing-skill-worker"));
});

function runSwarm(args, cwd) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 50 * 1024 * 1024,
  });
}
