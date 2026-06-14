import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "dist", "cli.js");
const template = path.join(repoRoot, "fixtures", "templates", "invoice-api");
const refs = ["AC-INV-001.1", "AC-INV-001.2", "AC-INV-001.3"];

test("codex reviewer records structured review evidence and gates final verification", () => {
  const { workspace, sliceId } = setupWorkspace("test-review-accepted");
  const fakeCodexScript = writeFakeReviewCodex();

  runSwarm(workspace, ["run", sliceId, "--driver", "fixture", "--actor", "review-target-worker"]);
  const reviewOutput = runSwarm(
    workspace,
    ["review", sliceId, "--driver", "codex", "--actor", "independent-reviewer"],
    {
      SWARM_CODEX_COMMAND: process.execPath,
      SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
      FAKE_REVIEW_STATUS: "accepted",
      FAKE_REVIEW_REFS: JSON.stringify(refs),
    },
  );

  assert.match(reviewOutput, /Review accepted/);
  assert.ok(fs.existsSync(path.join(workspace, "schemas", "review-result.schema.json")));

  const reviewed = JSON.parse(runSwarm(workspace, ["observe", "--events", "50"]));
  const sliceBeforeVerify = reviewed.slices.find((item) => item.id === sliceId);
  assert.equal(sliceBeforeVerify.status, "ready_for_review");
  assert.equal(sliceBeforeVerify.reviewResult.status, "accepted");
  assert.ok(sliceBeforeVerify.evidence.some((item) => item.kind === "review_result"));
  assert.ok(
    reviewed.agentRuns.some(
      (run) => run.actor === "independent-reviewer" && run.driver === "codex" && run.status === "completed",
    ),
  );
  assert.ok(
    reviewed.recentEvents.some(
      (event) =>
        event.type === "reviewer.agent_event" &&
        event.actor === "independent-reviewer" &&
        event.payload.agentEventType === "review.analysis",
    ),
  );

  const verifyOutput = runSwarm(workspace, ["verify", sliceId, "--actor", "deterministic-verifier"]);
  assert.match(verifyOutput, /Verification passed/);

  const accepted = JSON.parse(runSwarm(workspace, ["observe", "--events", "50"]));
  const sliceAfterVerify = accepted.slices.find((item) => item.id === sliceId);
  assert.equal(sliceAfterVerify.status, "accepted");
  assert.ok(sliceAfterVerify.leases.every((lease) => lease.status === "completed"));
  const commandEvidence = sliceAfterVerify.evidence.filter((item) => item.kind === "command").at(-1);
  assert.equal(commandEvidence.payload.reviewGate.reason, "latest review accepted");

  const report = runSwarm(workspace, ["report", sliceId]);
  assert.match(report, /Latest review:/);
  assert.match(report, /status: accepted/);
  assert.match(report, /recommendation: Proceed to deterministic verification./);
});

test("deterministic verification blocks when latest reviewer reports material failure", () => {
  const { workspace, sliceId } = setupWorkspace("test-review-blocked");
  const fakeCodexScript = writeFakeReviewCodex();

  runSwarm(workspace, ["run", sliceId, "--driver", "fixture", "--actor", "blocked-review-worker"]);
  const reviewOutput = runSwarm(
    workspace,
    ["review", sliceId, "--driver", "codex", "--actor", "blocking-reviewer"],
    {
      SWARM_CODEX_COMMAND: process.execPath,
      SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
      FAKE_REVIEW_STATUS: "blocked",
      FAKE_REVIEW_REFS: JSON.stringify(refs),
    },
  );

  assert.match(reviewOutput, /Review blocked/);

  const verifyOutput = runSwarm(workspace, ["verify", sliceId, "--actor", "post-review-verifier", "--force"]);
  assert.match(verifyOutput, /Verification failed/);
  assert.match(verifyOutput, /review gate: latest review status is blocked/);

  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "60"]));
  const slice = snapshot.slices.find((item) => item.id === sliceId);
  assert.equal(slice.status, "blocked");
  assert.equal(slice.reviewResult.status, "blocked");
  assert.ok(slice.leases.every((lease) => lease.status === "active"));
  assert.ok(
    snapshot.activeEscalations.some(
      (item) => item.entityId === sliceId && item.level === "blocker" && item.message.includes("reviewer blocked acceptance"),
    ),
  );
  const commandEvidence = slice.evidence.filter((item) => item.kind === "command").at(-1);
  assert.equal(commandEvidence.payload.passed, false);
  assert.equal(commandEvidence.payload.reviewGate.status, "blocked");
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

function writeFakeReviewCodex() {
  const fakeCodexDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-swarm-fake-reviewer-"));
  const scriptPath = path.join(fakeCodexDir, "fake-review-codex.mjs");
  fs.writeFileSync(
    scriptPath,
    `import fs from "node:fs";
const args = process.argv.slice(2);
function readStdin() {
  try { return fs.readFileSync(0, "utf8"); } catch { return ""; }
}
const outputIndex = args.indexOf("--output-last-message");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
const status = process.env.FAKE_REVIEW_STATUS || "accepted";
const refs = JSON.parse(process.env.FAKE_REVIEW_REFS || "[]");
const accepted = status === "accepted";
const prompt = readStdin() || args.at(-1) || "";
const sandboxIndex = args.indexOf("--sandbox");
if (sandboxIndex >= 0 && args[sandboxIndex + 1] === "read-only") {
  console.error("reviewer should use normal configured command/tool access, not forced read-only sandbox");
  process.exit(3);
}
if (!prompt.includes("You may run npm test, node --test, git, shell, or other local inspection commands")) {
  console.error("review prompt is missing the reviewer command/tool access rule");
  process.exit(2);
}
if (!prompt.includes("safe.directory=") || !prompt.includes("normalized forward-slash path")) {
  console.error("review prompt should recommend normalized forward-slash git safe.directory usage");
  process.exit(4);
}
console.log(JSON.stringify({ type: "thread.started", thread_id: "fake-review-thread" }));
console.log(JSON.stringify({ type: "review.analysis", status }));
if (outputPath) {
  fs.writeFileSync(outputPath, JSON.stringify({
    status,
    summary: accepted ? "fake reviewer accepted slice" : "fake reviewer blocked acceptance",
    frAcFindings: refs.map((ref) => ({
      ref,
      status: accepted ? "passed" : "failed",
      evidence: ["fake-review-evidence"],
      finding: accepted ? "review finding passed" : "reviewer blocked acceptance for material behavior gap"
    })),
    testAssessment: accepted ? "Recorded tests and evidence are coherent." : "Tests do not prove the claimed runtime behavior.",
    sourceMutationDetected: false,
    stubOrHardcodeRisk: accepted ? "none" : "high",
    requiredFixes: accepted ? [] : ["Replace shallow proof with runtime behavior evidence."],
    escalations: accepted ? [] : [{ level: "blocker", message: "reviewer blocked acceptance for material behavior gap" }],
    recommendation: accepted ? "Proceed to deterministic verification." : "Repair implementation before acceptance."
  }) + "\\n", "utf8");
}
console.log(JSON.stringify({ type: "turn.completed" }));
`,
    "utf8",
  );
  return scriptPath;
}
