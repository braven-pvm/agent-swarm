import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "dist", "cli.js");
const template = path.join(repoRoot, "fixtures", "templates", "invoice-api");

// RE-1 foundation: the skeptic is an INDEPENDENT role that challenges the latest review findings.
// It records its verdict as durable evidence (kind:"finding_challenge") + skeptic.* events, runs
// through the model-agnostic driver registry (fixture here, no provider spend), and is ADDITIVE:
// it never mutates the accept/review gate (that consumption is RE-2).

test("(a) skeptic runs as a DISTINCT role+actor through the fixture driver", () => {
  const { workspace, sliceId } = setupWorkspace("test-skeptic-distinct");
  const workerActor = "skeptic-target-worker";
  const reviewerActor = "skeptic-target-reviewer";
  const skepticActor = "independent-skeptic";

  runSwarm(workspace, ["run", sliceId, "--driver", "fixture", "--actor", workerActor]);
  runSwarm(workspace, ["review", sliceId, "--driver", "fixture", "--actor", reviewerActor]);
  const skepticOutput = runSwarm(workspace, ["skeptic", sliceId, "--driver", "fixture", "--actor", skepticActor]);

  assert.match(skepticOutput, /Skeptic /);
  assert.ok(fs.existsSync(path.join(workspace, "schemas", "skeptic-result.schema.json")));

  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "80"]));
  const skepticRun = snapshot.agentRuns.find((run) => run.role === "skeptic");
  assert.ok(skepticRun, "expected an agent run with role 'skeptic'");
  assert.equal(skepticRun.actor, skepticActor);
  assert.equal(skepticRun.driver, "fixture");
  assert.equal(skepticRun.status, "completed");
  // Independence: the skeptic actor is neither the worker nor the reviewer actor.
  assert.notEqual(skepticRun.actor, workerActor);
  assert.notEqual(skepticRun.actor, reviewerActor);
});

test("(b) skeptic records finding_challenge evidence and skeptic.* events", () => {
  const { workspace, sliceId } = setupWorkspace("test-skeptic-evidence");
  runSwarm(workspace, ["run", sliceId, "--driver", "fixture", "--actor", "ev-worker"]);
  runSwarm(workspace, ["review", sliceId, "--driver", "fixture", "--actor", "ev-reviewer"]);
  runSwarm(workspace, ["skeptic", sliceId, "--driver", "fixture", "--actor", "ev-skeptic"]);

  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "120"]));
  const slice = snapshot.slices.find((item) => item.id === sliceId);
  const challenge = slice.evidence.find((item) => item.kind === "finding_challenge");
  assert.ok(challenge, "expected finding_challenge evidence on the slice");
  assert.ok(challenge.summary.startsWith("Skeptic "));

  const eventTypes = snapshot.recentEvents.map((event) => event.type);
  assert.ok(eventTypes.includes("skeptic.started"), "expected a skeptic.started event");
  assert.ok(eventTypes.includes("skeptic.completed"), "expected a skeptic.completed event");
  assert.ok(
    snapshot.recentEvents.some((event) => event.type === "skeptic.finding_challenged"),
    "expected at least one skeptic.finding_challenged event (one per verdict)",
  );
});

test("(c) independence guard rejects reusing the worker or reviewer actor and leaves the ledger untouched", () => {
  const { workspace, sliceId } = setupWorkspace("test-skeptic-independence");
  const workerActor = "guard-worker";
  const reviewerActor = "guard-reviewer";
  runSwarm(workspace, ["run", sliceId, "--driver", "fixture", "--actor", workerActor]);
  runSwarm(workspace, ["review", sliceId, "--driver", "fixture", "--actor", reviewerActor]);

  for (const reusedActor of [workerActor, reviewerActor]) {
    let threw = false;
    let combined = "";
    try {
      runSwarm(workspace, ["skeptic", sliceId, "--driver", "fixture", "--actor", reusedActor]);
    } catch (err) {
      threw = true;
      combined = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
    assert.ok(threw, `skeptic with reused actor '${reusedActor}' must exit non-zero`);
    assert.match(combined, /must be independent|distinct/i);

    const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "120"]));
    const slice = snapshot.slices.find((item) => item.id === sliceId);
    // Ledger untouched on guard rejection: no finding_challenge evidence, no skeptic agent run.
    assert.equal(
      slice.evidence.filter((item) => item.kind === "finding_challenge").length,
      0,
      `no finding_challenge evidence should exist after rejecting '${reusedActor}'`,
    );
    assert.equal(
      snapshot.agentRuns.filter((run) => run.role === "skeptic").length,
      0,
      `no skeptic agent run should exist after rejecting '${reusedActor}'`,
    );
  }
});

test("(d) accept-gate behavior is UNCHANGED by the skeptic (additivity regression)", () => {
  const { workspace, sliceId } = setupWorkspace("test-skeptic-gate-unchanged");
  runSwarm(workspace, ["run", sliceId, "--driver", "fixture", "--actor", "gate-worker"]);
  runSwarm(workspace, ["review", sliceId, "--driver", "fixture", "--actor", "gate-reviewer"]);

  // Capture the full gate state BEFORE the skeptic runs.
  const before = JSON.parse(runSwarm(workspace, ["observe", "--events", "120"]));
  const sliceBefore = before.slices.find((item) => item.id === sliceId);
  const statusBefore = sliceBefore.status;
  const reviewResultBefore = sliceBefore.reviewResult;
  const reviewEscalationsBefore = before.activeEscalations.filter((item) => item.entityId === sliceId);

  runSwarm(workspace, ["skeptic", sliceId, "--driver", "fixture", "--actor", "gate-skeptic"]);

  const after = JSON.parse(runSwarm(workspace, ["observe", "--events", "120"]));
  const sliceAfter = after.slices.find((item) => item.id === sliceId);
  const reviewEscalationsAfter = after.activeEscalations.filter((item) => item.entityId === sliceId);

  // The skeptic mutated NONE of the gate state.
  assert.equal(sliceAfter.status, statusBefore, "slice.status must be unchanged by the skeptic");
  assert.deepEqual(sliceAfter.reviewResult, reviewResultBefore, "slice.reviewResult must be unchanged by the skeptic");
  assert.deepEqual(reviewEscalationsAfter, reviewEscalationsBefore, "slice review escalations must be unchanged by the skeptic");

  // And the deterministic verifier still gates ONLY on the review_result, ignoring finding_challenge:
  // an accepted review -> verification passes, with the review gate citing the accepted review.
  const verifyOutput = runSwarm(workspace, ["verify", sliceId, "--actor", "post-skeptic-verifier"]);
  assert.match(verifyOutput, /Verification passed/);

  const accepted = JSON.parse(runSwarm(workspace, ["observe", "--events", "120"]));
  const sliceAcceptedView = accepted.slices.find((item) => item.id === sliceId);
  assert.equal(sliceAcceptedView.status, "accepted");
  const commandEvidence = sliceAcceptedView.evidence.filter((item) => item.kind === "command").at(-1);
  assert.equal(commandEvidence.payload.reviewGate.reason, "latest review accepted");
});

function setupWorkspace(name) {
  const workspace = path.join(repoRoot, ".swarm-demo", `${name}-${process.pid}-${Date.now()}`);
  const target = path.join(workspace, "invoice-api");
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(template, target, { recursive: true });

  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["target", "init", target]);
  runSwarm(workspace, ["sources", "add-file", path.join(target, "specs", "invoice-api.md")]);
  const pullOutput = runSwarm(workspace, [
    "slices",
    "pull",
    "--target",
    "invoice-api",
    "--source",
    "invoice-api.md",
    "--batch-size",
    "3",
  ]);
  const sliceId = /Created slice (SLICE-[a-f0-9]+)/i.exec(pullOutput)?.[1];
  assert.ok(sliceId);
  return { workspace, target, sliceId };
}

function runSwarm(workspace, args, env = {}) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
