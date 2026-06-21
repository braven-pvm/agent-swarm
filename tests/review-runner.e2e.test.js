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
  assert.equal(sliceBeforeVerify.reviewResult.qualityGate.status, "passed");
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

test("codex reviewer recovers when a valid review artifact exists despite bad process exit", () => {
  const { workspace, sliceId } = setupWorkspace("test-review-artifact-recovery");
  const fakeCodexScript = writeFakeReviewCodex();

  runSwarm(workspace, ["run", sliceId, "--driver", "fixture", "--actor", "artifact-recovery-worker"]);
  const reviewOutput = runSwarm(
    workspace,
    ["review", sliceId, "--driver", "codex", "--actor", "artifact-recovery-reviewer"],
    {
      SWARM_CODEX_COMMAND: process.execPath,
      SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
      FAKE_REVIEW_STATUS: "accepted",
      FAKE_REVIEW_REFS: JSON.stringify(refs),
      FAKE_REVIEW_EXIT_CODE: "7",
    },
  );

  assert.match(reviewOutput, /Review accepted/);

  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "80"]));
  const slice = snapshot.slices.find((item) => item.id === sliceId);
  assert.equal(slice.status, "ready_for_review");
  assert.equal(slice.reviewResult.status, "accepted");
  assert.ok(
    snapshot.agentRuns.some(
      (run) => run.actor === "artifact-recovery-reviewer" && run.driver === "codex" && run.status === "completed",
    ),
  );
  const reviewCompleted = snapshot.recentEvents.find(
    (event) => event.type === "review.completed" && event.actor === "artifact-recovery-reviewer",
  );
  assert.equal(reviewCompleted.payload.exitCode, 7);
  assert.equal(reviewCompleted.payload.structuredResultWritten, true);
  assert.equal(reviewCompleted.payload.resultArtifactRecovered, true);
  assert.match(reviewCompleted.payload.recoveryReason, /exited with status 7/);
});

test("deterministic verification accepts review findings wrapped with a result suffix", () => {
  const { workspace, sliceId } = setupWorkspace("test-review-suffix-refs");
  const fakeCodexScript = writeFakeReviewCodex();

  runSwarm(workspace, ["run", sliceId, "--driver", "fixture", "--actor", "suffix-review-worker"]);
  const reviewOutput = runSwarm(
    workspace,
    ["review", sliceId, "--driver", "codex", "--actor", "suffix-reviewer"],
    {
      SWARM_CODEX_COMMAND: process.execPath,
      SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
      FAKE_REVIEW_STATUS: "accepted",
      FAKE_REVIEW_REFS: JSON.stringify(refs),
      FAKE_REVIEW_REF_SUFFIX: ".result",
    },
  );

  assert.match(reviewOutput, /Review accepted/);

  const verifyOutput = runSwarm(workspace, ["verify", sliceId, "--actor", "deterministic-verifier"]);
  assert.match(verifyOutput, /Verification passed/);

  const accepted = JSON.parse(runSwarm(workspace, ["observe", "--events", "50"]));
  const sliceAfterVerify = accepted.slices.find((item) => item.id === sliceId);
  assert.equal(sliceAfterVerify.status, "accepted");
  const reviewResult = sliceAfterVerify.reviewResult;
  assert.ok(reviewResult.frAcFindings.every((finding) => finding.ref.endsWith(".result")));
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

test("sleuth quality gate blocks acceptance even when reviewer status says accepted", () => {
  const { workspace, sliceId } = setupWorkspace("test-review-quality-blocked");
  const fakeCodexScript = writeFakeReviewCodex();

  runSwarm(workspace, ["run", sliceId, "--driver", "fixture", "--actor", "quality-review-worker"]);
  const reviewOutput = runSwarm(
    workspace,
    ["review", sliceId, "--driver", "codex", "--actor", "quality-reviewer"],
    {
      SWARM_CODEX_COMMAND: process.execPath,
      SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
      FAKE_REVIEW_STATUS: "accepted",
      FAKE_REVIEW_REFS: JSON.stringify(refs),
      FAKE_QUALITY_STATUS: "failed",
      FAKE_QUALITY_RISK: "high",
    },
  );

  assert.match(reviewOutput, /Review accepted/);

  const verifyOutput = runSwarm(workspace, ["verify", sliceId, "--actor", "post-quality-verifier", "--force"]);
  assert.match(verifyOutput, /Verification failed/);
  assert.match(verifyOutput, /review gate: latest review quality gate failed/);

  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "80"]));
  const slice = snapshot.slices.find((item) => item.id === sliceId);
  assert.equal(slice.status, "blocked");
  assert.equal(slice.reviewResult.status, "accepted");
  assert.equal(slice.reviewResult.qualityGate.status, "failed");
  assert.ok(
    snapshot.activeEscalations.some(
      (item) => item.entityId === sliceId && item.level === "blocker" && item.message.includes("Sleuth Review Gate"),
    ),
  );
  const commandEvidence = slice.evidence.filter((item) => item.kind === "command").at(-1);
  assert.equal(commandEvidence.payload.passed, false);
  assert.equal(commandEvidence.payload.reviewGate.status, "blocked");
});

test("repair-required review remains repairable and a later accepted review clears review blockers", () => {
  const { workspace, sliceId } = setupWorkspace("test-review-repair-required");
  const fakeCodexScript = writeFakeReviewCodex();

  runSwarm(workspace, ["run", sliceId, "--driver", "fixture", "--actor", "repair-review-worker"]);
  const repairOutput = runSwarm(
    workspace,
    ["review", sliceId, "--driver", "codex", "--actor", "repair-reviewer"],
    {
      SWARM_CODEX_COMMAND: process.execPath,
      SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
      FAKE_REVIEW_STATUS: "repair_required",
      FAKE_REVIEW_REFS: JSON.stringify(refs),
    },
  );

  assert.match(repairOutput, /Review repair_required/);

  const repairSnapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "80"]));
  const repairingSlice = repairSnapshot.slices.find((item) => item.id === sliceId);
  assert.equal(repairingSlice.status, "repairing");
  assert.equal(repairingSlice.reviewResult.status, "repair_required");
  assert.ok(
    repairSnapshot.activeEscalations.some(
      (item) => item.entityId === sliceId && item.level === "blocker" && item.message.includes("Sleuth Review Gate"),
    ),
  );

  const acceptedOutput = runSwarm(
    workspace,
    ["review", sliceId, "--driver", "codex", "--actor", "repair-reviewer"],
    {
      SWARM_CODEX_COMMAND: process.execPath,
      SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
      FAKE_REVIEW_STATUS: "accepted",
      FAKE_REVIEW_REFS: JSON.stringify(refs),
    },
  );

  assert.match(acceptedOutput, /Review accepted/);

  const acceptedSnapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "100"]));
  const reviewedSlice = acceptedSnapshot.slices.find((item) => item.id === sliceId);
  assert.equal(reviewedSlice.status, "ready_for_review");
  assert.equal(reviewedSlice.reviewResult.status, "accepted");
  assert.equal(
    acceptedSnapshot.activeEscalations.filter((item) => item.entityId === sliceId && item.level === "blocker").length,
    0,
  );
  assert.ok(
    acceptedSnapshot.recentEvents.some((event) => event.type === "escalation.cleared" && event.payload?.clearedAfterReviewAccepted),
  );
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
const exitCode = Number(process.env.FAKE_REVIEW_EXIT_CODE || "0");
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
if (!prompt.includes("Sleuth Review Gate") || !prompt.includes("real_world_readiness")) {
  console.error("review prompt is missing the structured sleuth quality gate");
  process.exit(5);
}
if (!prompt.includes("safe.directory=") || !prompt.includes("normalized forward-slash path")) {
  console.error("review prompt should recommend normalized forward-slash git safe.directory usage");
  process.exit(4);
}
console.log(JSON.stringify({ type: "thread.started", thread_id: "fake-review-thread" }));
console.log(JSON.stringify({ type: "review.analysis", status }));
const qualityStatus = process.env.FAKE_QUALITY_STATUS || (accepted ? "passed" : "failed");
const qualityRisk = process.env.FAKE_QUALITY_RISK || (accepted ? "none" : "high");
const refSuffix = process.env.FAKE_REVIEW_REF_SUFFIX || "";
const qualityDimensionStatus = qualityStatus === "failed" ? "failed" : "passed";
const qualityGate = {
  status: qualityStatus,
  summary: qualityStatus === "passed" ? "structured quality gate passed" : "structured quality gate found a material risk",
  dimensions: [
    "runtime_path",
    "stub_or_hardcode",
    "test_meaningfulness",
    "error_handling",
    "integration_fit",
    "maintainability",
    "real_world_readiness"
  ].map((dimension) => ({
    dimension,
    status: qualityDimensionStatus,
    risk: qualityRisk,
    evidence: ["fake-quality-evidence"],
    finding: qualityStatus === "passed" ? \`\${dimension} passed\` : \`\${dimension} failed material quality gate\`
  })),
  blockingConcerns: qualityStatus === "passed" ? [] : ["material quality gate failure"],
  residualRisks: []
};
if (outputPath) {
  fs.writeFileSync(outputPath, JSON.stringify({
    status,
    summary: accepted ? "fake reviewer accepted slice" : "fake reviewer blocked acceptance",
    frAcFindings: refs.map((ref) => ({
      ref: \`\${ref}\${refSuffix}\`,
      status: accepted ? "passed" : "failed",
      evidence: ["fake-review-evidence"],
      finding: accepted ? "review finding passed" : "reviewer blocked acceptance for material behavior gap"
    })),
    testAssessment: accepted ? "Recorded tests and evidence are coherent." : "Tests do not prove the claimed runtime behavior.",
    sourceMutationDetected: false,
    stubOrHardcodeRisk: accepted ? "none" : "high",
    qualityGate,
    requiredFixes: accepted ? [] : ["Replace shallow proof with runtime behavior evidence."],
    escalations: accepted ? [] : [{ level: "blocker", message: "reviewer blocked acceptance for material behavior gap" }],
    recommendation: accepted ? "Proceed to deterministic verification." : "Repair implementation before acceptance."
  }) + "\\n", "utf8");
}
console.log(JSON.stringify({ type: "turn.completed" }));
if (exitCode) process.exit(exitCode);
`,
    "utf8",
  );
  return scriptPath;
}
