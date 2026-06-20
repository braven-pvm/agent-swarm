import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { recordHumanVerification } from "../dist/human-actions.js";
import { SwarmStore } from "../dist/storage.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "dist", "cli.js");

test("support triage overseer prompt prioritizes backend enabler work before product readiness", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-live-agent-support-triage-priority-${process.pid}-${Date.now()}`);
  const fakeCodex = writeFakeCodexScript(path.join(repoRoot, ".swarm-demo", `test-h2-priority-fake-codex-${process.pid}-${Date.now()}.mjs`));

  execFileSync(
    process.execPath,
    [cli, "smoke", "live-agent", "reset", "--scenario", "live-agent-smoke-h2", "--workspace", workspace],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  execFileSync(process.execPath, [cli, "orchestrate", "--actor", "h2-live-overseer", "--driver", "codex", "--scenario", "live-agent-smoke-h2"], {
    cwd: workspace,
    env: {
      ...process.env,
      SWARM_CODEX_COMMAND: process.execPath,
      SWARM_CODEX_ARGS: JSON.stringify([fakeCodex]),
      FAKE_SWARM_CLI: cli,
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 50 * 1024 * 1024,
  });

  const promptDir = path.join(workspace, ".swarm", "artifacts", "scenario-live-agent-smoke-h2");
  const promptPath = fs
    .readdirSync(promptDir)
    .filter((name) => /^overseer-prompt-.*\.md$/.test(name))
    .map((name) => path.join(promptDir, name))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0];
  assert.ok(promptPath, "expected generated overseer prompt");

  const prompt = fs.readFileSync(promptPath, "utf8");
  const snapshotMatch = /Current harness snapshot:\r?\n([\s\S]*?)\r?\n\r?\nReturn only/.exec(prompt);
  assert.ok(snapshotMatch, "expected prompt to include current harness snapshot JSON");
  const snapshot = JSON.parse(snapshotMatch[1]);
  const queue = snapshot.actionableState.nextSourcePullQueue;
  assert.equal(queue[0].sourceDomain, "Support Backend");
  assert.equal(queue[0].targetName, "support-api");
  assert.equal(queue[0].batchSize, 8);
  assert.deepEqual(queue[0].availableRefs.slice(0, queue[0].batchSize), [
    "FR-SUP-API-001",
    "AC-SUP-API-001.1",
    "AC-SUP-API-001.2",
    "AC-SUP-API-001.3",
    "AC-SUP-API-001.4",
    "AC-SUP-API-001.5",
    "AC-SUP-API-001.6",
    "AC-SUP-API-001.7",
  ]);
  assert.match(queue[0].nextCommand, /slices pull --target support-api .* --batch-size 8/);
  assert.equal(queue.at(-1).sourceDomain, "Support Product");
});

test("support triage full smoke uses real runner wiring and records lifecycle artifacts", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-live-agent-support-triage-live-${process.pid}-${Date.now()}`);
  const summaryPath = path.join(workspace, "h2-live-summary.json");
  const artifactDir = path.join(workspace, "h2-live-artifacts");
  const fakeCodex = writeFakeCodexScript(path.join(repoRoot, ".swarm-demo", `test-h2-fake-codex-${process.pid}-${Date.now()}.mjs`));
  const output = execFileSync(
    process.execPath,
    [
      cli,
      "smoke",
      "live-agent",
      "full",
      "--reset",
      "--scenario",
      "live-agent-smoke-h2",
      "--workspace",
      workspace,
      "--summary",
      summaryPath,
      "--artifacts",
      artifactDir,
      "--max-turns",
      "4",
      "--execute-limit",
      "1",
      "--max-slices",
      "5",
      "--max-agent-runs",
      "12",
      "--max-runtime-seconds",
      "180",
      "--no-history",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        SWARM_CODEX_COMMAND: process.execPath,
        SWARM_CODEX_ARGS: JSON.stringify([fakeCodex]),
        FAKE_SWARM_CLI: cli,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 50 * 1024 * 1024,
    },
  );
  const summary = JSON.parse(output);

  assert.equal(summary.scenario, "live-agent-smoke-h2");
  assert.equal(summary.phase, "phase-11d-h2-real-agent-run");
  assert.equal(summary.driver, "codex");
  assert.equal(summary.finalOutcome, "blocked");
  assert.ok(summary.turns.some((turn) => turn.kind === "overseer"));
  assert.ok(summary.turns.some((turn) => turn.kind === "verify"));
  assert.ok(summary.counts.acceptedSlices >= 1);
  assert.ok(summary.coverage.done > 0);
  assert.equal(summary.productReadiness.passed, false);
  assert.ok(summary.productReadiness.blockers.some((blocker) => blocker.id === "product-start-probed"));

  for (const artifact of [
    summary.artifacts.summary,
    summary.artifacts.finalSnapshot,
    summary.artifacts.graph,
    summary.artifacts.coverage,
    summary.artifacts.humanActions,
    summary.artifacts.productReadiness,
    summary.artifacts.productReadinessMarkdown,
  ]) {
    assert.ok(fs.existsSync(artifact), `missing artifact ${artifact}`);
  }

  const snapshot = JSON.parse(fs.readFileSync(summary.artifacts.finalSnapshot, "utf8"));
  assert.ok(snapshot.agentRuns.some((run) => run.role === "overseer" && run.driver === "codex"));
  assert.ok(snapshot.agentRuns.some((run) => run.role === "worker" && run.driver === "codex"));
  assert.ok(snapshot.agentRuns.some((run) => run.role === "reviewer" && run.driver === "codex"));
  assert.ok(snapshot.slices.some((slice) => slice.status === "accepted" && slice.targetId));

  const manifest = JSON.parse(fs.readFileSync(path.join(workspace, "live-agent-smoke.json"), "utf8"));
  assert.equal(manifest.runnerStatus, "real_agent_run_blocked");
  assert.equal(manifest.liveRun.runId, summary.runId);
});

test("support triage full smoke treats repairable review blockers as autonomous repair work", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-live-agent-support-triage-repair-${process.pid}-${Date.now()}`);
  const summaryPath = path.join(workspace, "h2-live-summary.json");
  const artifactDir = path.join(workspace, "h2-live-artifacts");
  const fakeCodex = writeFakeCodexScript(path.join(repoRoot, ".swarm-demo", `test-h2-repair-fake-codex-${process.pid}-${Date.now()}.mjs`));
  const repairMarker = path.join(workspace, "fake-review-repair-once.marker");
  const output = execFileSync(
    process.execPath,
    [
      cli,
      "smoke",
      "live-agent",
      "full",
      "--reset",
      "--scenario",
      "live-agent-smoke-h2",
      "--workspace",
      workspace,
      "--summary",
      summaryPath,
      "--artifacts",
      artifactDir,
      "--max-turns",
      "6",
      "--execute-limit",
      "1",
      "--max-slices",
      "5",
      "--max-agent-runs",
      "16",
      "--max-runtime-seconds",
      "180",
      "--no-history",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        SWARM_CODEX_COMMAND: process.execPath,
        SWARM_CODEX_ARGS: JSON.stringify([fakeCodex]),
        FAKE_SWARM_CLI: cli,
        FAKE_H2_REPAIR_ONCE_MARKER: repairMarker,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 50 * 1024 * 1024,
    },
  );
  const summary = JSON.parse(output);

  assert.equal(summary.finalOutcome, "blocked");
  assert.doesNotMatch(summary.finalReason, /human/i);
  assert.ok(summary.turns.some((turn) => turn.kind === "verify" && turn.accepted === true));

  const snapshot = JSON.parse(fs.readFileSync(summary.artifacts.finalSnapshot, "utf8"));
  const acceptedSlice = snapshot.slices.find((slice) => slice.status === "accepted");
  assert.ok(acceptedSlice, "expected repaired slice to reach accepted");
  assert.ok(snapshot.recentEvents.some((event) => event.type === "review.blocked_acceptance"));
  assert.ok(snapshot.recentEvents.some((event) => event.type === "escalation.cleared" && event.payload?.clearedAfterReviewAccepted));
  assert.equal(
    snapshot.activeEscalations.filter((item) => item.entityId === acceptedSlice.id && item.level === "blocker").length,
    0,
  );

  const humanActions = JSON.parse(fs.readFileSync(summary.artifacts.humanActions, "utf8"));
  assert.equal(humanActions.totals.decisionRequired, 0);
  assert.equal(humanActions.totals.humanVerification, 0);
});

test("support triage full smoke treats failed human verification as autonomous repair work", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-live-agent-support-triage-human-rework-${process.pid}-${Date.now()}`);
  const summaryPath = path.join(workspace, "h2-live-summary.json");
  const artifactDir = path.join(workspace, "h2-live-artifacts");
  const fakeCodex = writeFakeCodexScript(path.join(repoRoot, ".swarm-demo", `test-h2-human-rework-fake-codex-${process.pid}-${Date.now()}.mjs`));

  execFileSync(
    process.execPath,
    [cli, "smoke", "live-agent", "reset", "--scenario", "live-agent-smoke-h2", "--workspace", workspace],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const seeded = seedFailedHumanVerification(workspace);

  const output = execFileSync(
    process.execPath,
    [
      cli,
      "smoke",
      "live-agent",
      "full",
      "--scenario",
      "live-agent-smoke-h2",
      "--workspace",
      workspace,
      "--summary",
      summaryPath,
      "--artifacts",
      artifactDir,
      "--max-turns",
      "1",
      "--execute-limit",
      "1",
      "--max-slices",
      "5",
      "--max-agent-runs",
      "8",
      "--max-runtime-seconds",
      "120",
      "--no-history",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        SWARM_CODEX_COMMAND: process.execPath,
        SWARM_CODEX_ARGS: JSON.stringify([fakeCodex]),
        FAKE_SWARM_CLI: cli,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 50 * 1024 * 1024,
    },
  );
  const summary = JSON.parse(output);

  assert.equal(summary.finalOutcome, "blocked");
  assert.doesNotMatch(summary.finalReason, /human intervention queue|human_required/i);
  assert.ok(
    summary.turns.every((turn) => turn.kind !== "human-verification-rework-visible"),
    "failed human verification should not remain visible as a human action after the human records a result",
  );
  assert.equal(summary.humanActions.humanVerification, 0, "failed human verification should clear the human-verification queue");
  const targetedRepair = summary.turns.find((turn) => turn.kind === "targeted-repair-dispatch" && turn.sliceId === seeded.sliceId);
  assert.ok(targetedRepair, "failed human verification should dispatch a targeted repair worker before another overseer inspect cycle");
  assert.equal(targetedRepair.actor, "dashboard-worker");
  assert.match(targetedRepair.repairContext.humanFeedback[0].notes, /Dropdowns and text inputs/);

  const snapshot = JSON.parse(fs.readFileSync(summary.artifacts.finalSnapshot, "utf8"));
  assert.ok(snapshot.recentEvents.some((event) => event.type === "repair.targeted_dispatch" && event.entityId === seeded.sliceId));
  const promptPath = fs
    .readdirSync(path.join(workspace, ".swarm", "artifacts", seeded.sliceId))
    .filter((name) => /^worker-prompt-.*\.md$/.test(name))
    .map((name) => path.join(workspace, ".swarm", "artifacts", seeded.sliceId, name))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0];
  assert.ok(promptPath, "expected worker prompt to be written");
  const prompt = fs.readFileSync(promptPath, "utf8");
  assert.match(prompt, /Targeted repair context/);
  assert.match(prompt, /Human verification feedback requiring repair/);
  assert.match(prompt, /Dropdowns and text inputs close or clear/);
});

test("support triage full smoke stops high-retry repair loops with a visible blocker", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-live-agent-support-triage-retry-budget-${process.pid}-${Date.now()}`);
  const summaryPath = path.join(workspace, "h2-live-summary.json");
  const artifactDir = path.join(workspace, "h2-live-artifacts");
  const fakeCodex = writeFakeCodexScript(path.join(repoRoot, ".swarm-demo", `test-h2-retry-budget-fake-codex-${process.pid}-${Date.now()}.mjs`));

  execFileSync(
    process.execPath,
    [cli, "smoke", "live-agent", "reset", "--scenario", "live-agent-smoke-h2", "--workspace", workspace],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const seeded = seedFailedHumanVerification(workspace);
  seedRepairAttemptPressure(workspace, seeded.sliceId, 4);

  const output = execFileSync(
    process.execPath,
    [
      cli,
      "smoke",
      "live-agent",
      "full",
      "--scenario",
      "live-agent-smoke-h2",
      "--workspace",
      workspace,
      "--summary",
      summaryPath,
      "--artifacts",
      artifactDir,
      "--max-turns",
      "4",
      "--execute-limit",
      "1",
      "--max-slices",
      "5",
      "--max-agent-runs",
      "20",
      "--max-runtime-seconds",
      "120",
      "--max-repair-attempts",
      "3",
      "--no-history",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        SWARM_CODEX_COMMAND: process.execPath,
        SWARM_CODEX_ARGS: JSON.stringify([fakeCodex]),
        FAKE_SWARM_CLI: cli,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 50 * 1024 * 1024,
    },
  );
  const summary = JSON.parse(output);

  assert.equal(summary.finalOutcome, "blocked");
  assert.match(summary.finalReason, /Repair retry budget exhausted/);
  const budgetTurn = summary.turns.find((turn) => turn.kind === "repair-retry-budget-exhausted");
  assert.ok(budgetTurn, "expected retry-budget stop to be recorded in the run summary");
  assert.equal(budgetTurn.sliceId, seeded.sliceId);
  assert.equal(budgetTurn.maxRepairAttempts, 3);

  const snapshot = JSON.parse(fs.readFileSync(summary.artifacts.finalSnapshot, "utf8"));
  assert.ok(
    snapshot.activeEscalations.some((item) => item.entityId === seeded.sliceId && item.message === "Repair retry budget exhausted."),
    "retry-budget exhaustion should be visible as an active blocker",
  );
  assert.ok(snapshot.recentEvents.some((event) => event.type === "repair.retry_budget_exhausted" && event.entityId === seeded.sliceId));
});

test("support triage product readiness uses configured JSON fields and workflow probes", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-live-agent-support-triage-readiness-${process.pid}-${Date.now()}`);
  const summaryPath = path.join(workspace, "h2-live-summary.json");
  const artifactDir = path.join(workspace, "h2-live-artifacts");
  const fakeCodex = writeFakeCodexScript(path.join(repoRoot, ".swarm-demo", `test-h2-readiness-fake-codex-${process.pid}-${Date.now()}.mjs`));

  execFileSync(
    process.execPath,
    [cli, "smoke", "live-agent", "reset", "--scenario", "live-agent-smoke-h2", "--workspace", workspace],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  writeRunnableSupportUi(path.join(workspace, "support-ui"));

  const output = execFileSync(
    process.execPath,
    [
      cli,
      "smoke",
      "live-agent",
      "full",
      "--scenario",
      "live-agent-smoke-h2",
      "--workspace",
      workspace,
      "--summary",
      summaryPath,
      "--artifacts",
      artifactDir,
      "--max-turns",
      "1",
      "--execute-limit",
      "1",
      "--max-slices",
      "5",
      "--max-agent-runs",
      "8",
      "--max-runtime-seconds",
      "120",
      "--no-history",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        SWARM_CODEX_COMMAND: process.execPath,
        SWARM_CODEX_ARGS: JSON.stringify([fakeCodex]),
        FAKE_SWARM_CLI: cli,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 50 * 1024 * 1024,
    },
  );
  const summary = JSON.parse(output);

  assert.equal(summary.finalOutcome, "blocked");
  assert.equal(summary.productReadiness.passed, true);
  assert.equal(summary.productReadiness.blockers.length, 0);
  assert.equal(summary.finalCoverageGate.passed, false);
  assert.match(summary.finalCoverageGate.reason, /coverage is partial/i);

  const readiness = JSON.parse(fs.readFileSync(summary.artifacts.productReadiness, "utf8"));
  assert.equal(readiness.commandResults.start.passed, true);
  assert.equal(readiness.commandResults.start.probes.api.passed, true);
  assert.deepEqual(readiness.commandResults.start.probes.api.expectedJsonFields, [
    "openTicketCount",
    "breachedSlaCount",
    "urgentTicketCount",
    "unassignedTicketCount",
  ]);
  assert.equal(readiness.commandResults.start.probes.workflow.passed, true);
  assert.equal(readiness.commandResults.start.probes.workflow.noteRecorded, true);
  assert.equal(readiness.commandResults.start.probes.workflow.deltaOk, true);
  assert.equal(readiness.commandResults.start.probes.workflow.assignmentPreview.id, "TCK-100");
  assert.equal(readiness.commandResults.start.probes.workflow.notePreview.body, "Contacted customer.");
});

test("support triage full smoke creates visible coverage-completion work after readiness passes", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-live-agent-support-triage-coverage-${process.pid}-${Date.now()}`);
  const summaryPath = path.join(workspace, "h2-live-summary.json");
  const artifactDir = path.join(workspace, "h2-live-artifacts");
  const fakeCodex = writeFakeCodexScript(path.join(repoRoot, ".swarm-demo", `test-h2-coverage-fake-codex-${process.pid}-${Date.now()}.mjs`));

  execFileSync(
    process.execPath,
    [cli, "smoke", "live-agent", "reset", "--scenario", "live-agent-smoke-h2", "--workspace", workspace],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  writeRunnableSupportUi(path.join(workspace, "support-ui"));

  const output = execFileSync(
    process.execPath,
    [
      cli,
      "smoke",
      "live-agent",
      "full",
      "--scenario",
      "live-agent-smoke-h2",
      "--workspace",
      workspace,
      "--summary",
      summaryPath,
      "--artifacts",
      artifactDir,
      "--max-turns",
      "4",
      "--execute-limit",
      "1",
      "--max-slices",
      "8",
      "--max-agent-runs",
      "16",
      "--max-runtime-seconds",
      "180",
      "--no-history",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        SWARM_CODEX_COMMAND: process.execPath,
        SWARM_CODEX_ARGS: JSON.stringify([fakeCodex]),
        FAKE_SWARM_CLI: cli,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 50 * 1024 * 1024,
    },
  );
  const summary = JSON.parse(output);

  assert.equal(summary.finalOutcome, "blocked");
  assert.equal(summary.productReadiness.passed, true);
  assert.equal(summary.finalCoverageGate.passed, false);
  assert.ok(summary.finalCoverageGate.incompleteCount > 0);

  const completionTurn = summary.turns.find((turn) => turn.kind === "coverage-completion-slice-created");
  assert.ok(completionTurn, "expected a visible coverage-completion slice to be created");
  assert.equal(completionTurn.coveragePackKey, "support-backend-sup-api-001");
  assert.ok(completionTurn.refs.some((ref) => ref.startsWith("AC-SUP-API-001.")));
  assert.ok(completionTurn.refs.length <= 12);

  const snapshot = JSON.parse(fs.readFileSync(summary.artifacts.finalSnapshot, "utf8"));
  const supportApiTarget = snapshot.targets.find((target) => target.name === "support-api");
  assert.ok(supportApiTarget, "support-api target should be registered");
  assert.equal(completionTurn.targetId, supportApiTarget.id);
  const completionSlice = snapshot.slices.find((slice) => slice.id === completionTurn.sliceId);
  assert.ok(completionSlice, "completion slice should be present in final snapshot");
  assert.equal(completionSlice.status, "ready");
  assert.equal(completionSlice.targetId, supportApiTarget.id);
  assert.ok(completionSlice.unblockTargets.includes("h2-full-product-coverage-gate"));
  assert.equal(completionSlice.verificationObligations.length, completionTurn.refs.length);
  assert.ok(completionSlice.verificationObligations.every((obligation) => obligation.immutable === true));
  assert.ok(
    snapshot.recentEvents.some(
      (event) =>
        event.type === "coverage_completion.slice_created" &&
        event.entityId === completionTurn.sliceId &&
        event.payload.coveragePackKey === "support-backend-sup-api-001",
    ),
    "coverage-completion event should be observable",
  );
});

function seedFailedHumanVerification(workspace) {
  const store = new SwarmStore(workspace);
  try {
    const now = new Date().toISOString();
    const source = store.listSources().find((item) => item.title === "Live Smoke Support Triage UI Requirements");
    const target = store.listTargets().find((item) => item.name === "support-ui");
    assert.ok(source, "expected support UI source");
    assert.ok(target, "expected support-ui target");

    const ref = "AC-SUP-UI-007.1";
    const laneId = "LANE-human-rework";
    const sliceId = "SLICE-human-rework";
    const packetId = "HVP-human-rework";
    const packetEvidenceId = "EVD-human-packet";
    const verifyEvidenceId = "EVD-human-awaiting";
    const artifactDir = path.join(workspace, ".swarm", "artifacts", sliceId);
    const markdownPath = path.join(artifactDir, "human-verification-AC-SUP-UI-007.1-HVP-human-rework.md");
    const jsonPath = path.join(artifactDir, "human-verification-AC-SUP-UI-007.1-HVP-human-rework.json");
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(markdownPath, "# Human verification packet\n\nReview desktop board scannability.\n", "utf8");
    fs.writeFileSync(jsonPath, `${JSON.stringify({ packetId, ref, status: "awaiting_human_verification" }, null, 2)}\n`, "utf8");

    store.insertLane({
      id: laneId,
      name: "Human Rework Lane",
      purpose: "Repair failed human visual verification.",
      focusLabels: ["h2", "human-rework", "support-ui"],
      targetId: target.id,
      orchestrator: "h2-live-overseer",
      worktree: target.path,
      state: "active",
      createdAt: now,
      updatedAt: now,
    });
    store.insertSlice({
      id: sliceId,
      laneId,
      targetId: target.id,
      title: `Repair failed human verification for ${ref}`,
      status: "ready_for_review",
      sourceRefs: [
        {
          adapterId: source.adapterId,
          kind: source.kind,
          uri: source.uri,
          title: source.title,
          hash: source.hash,
        },
      ],
      frAcRefs: [ref],
      deliveryQuestion: `Can the support UI satisfy the failed human verification feedback for ${ref}?`,
      workPackageType: "component_pack",
      minimumMeaningfulOutcome: "removes_blocker",
      scope: [`Repair the visible behavior required by ${ref}.`],
      outOfScope: ["Do not mutate source specs.", "Do not mark the ref complete without human recheck."],
      expectedEvidence: ["Human can verify desktop board scannability with summary, filters, queue, and detail context visible."],
      verificationObligations: [
        {
          ref,
          sourceRef: source.id,
          sourceUri: source.uri,
          sourceTitle: source.title,
          sourceText: "AC-SUP-UI-007.1: A human can verify desktop board scannability with summary, filters, queue, and detail context visible.",
          sourceContext: "FR-SUP-UI-007: Human-Verifiable Visual Quality",
          mode: "human_verification_required",
          responsibleParty: "human-qa",
          criteria: [
            {
              id: `${ref}.result`,
              expectedOutcome:
                "AC-SUP-UI-007.1: A human can verify desktop board scannability with summary, filters, queue, and detail context visible.",
              evidenceRequired: ["worker_evidence", "review_result", "verification_command", "human_verification"],
              acceptanceThreshold: "worker coverage, review, deterministic verification, and human verification all pass",
            },
          ],
          createdBy: "planner",
          createdAt: now,
          immutable: true,
          guidance: ["Use the failed human notes as repair input.", "Do not mutate source specs."],
        },
      ],
      unblockTargets: ["human-verification"],
      verificationRequirements: ["Repair failed human verification and request a fresh human check."],
      createdAt: now,
      updatedAt: now,
    });
    store.insertLease({
      id: "LEASE-human-rework",
      frAcRef: ref,
      sliceId,
      laneId,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    store.insertEvidence({
      id: verifyEvidenceId,
      sliceId,
      kind: "command",
      ref,
      summary: "Deterministic verification produced a human verification packet",
      payload: {
        command: "verify",
        passed: false,
        frAcResults: [
          {
            ref,
            status: "awaiting_human_verification",
            evidenceIds: [packetEvidenceId],
            proof: "Implementation evidence exists, but human visual verification is required.",
            verifiedBy: "deterministic-verifier",
          },
        ],
      },
      createdAt: now,
    });
    store.insertEvidence({
      id: packetEvidenceId,
      sliceId,
      kind: "artifact",
      ref,
      summary: `Human verification packet for ${ref}`,
      payload: {
        type: "human_verification_packet",
        packetId,
        ref,
        status: "awaiting_human_verification",
        markdownPath,
        jsonPath,
        generatedAt: now,
      },
      createdAt: now,
    });

    recordHumanVerification(store, {
      sliceId,
      ref,
      status: "failed",
      actor: "human-test",
      notes: "Dropdowns and text inputs close or clear before values can be entered.",
    });
    return { sliceId, ref };
  } finally {
    store.close();
  }
}

function seedRepairAttemptPressure(workspace, sliceId, attempts) {
  const store = new SwarmStore(workspace);
  try {
    const now = new Date();
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const timestamp = new Date(now.getTime() + attempt * 1000).toISOString();
      store.insertAgentRun({
        id: `RUN-retry-pressure-${attempt}`,
        sliceId,
        role: attempt % 2 === 0 ? "reviewer" : "worker",
        entityType: "slice",
        entityId: sliceId,
        actor: attempt % 2 === 0 ? "dashboard-reviewer" : "dashboard-worker",
        driver: "codex",
        status: "completed",
        attempt,
        startedAt: timestamp,
        updatedAt: timestamp,
      });
    }
  } finally {
    store.close();
  }
}

function writeRunnableSupportUi(target) {
  fs.mkdirSync(path.join(target, "src"), { recursive: true });
  fs.mkdirSync(path.join(target, "test"), { recursive: true });
  fs.writeFileSync(
    path.join(target, "package.json"),
    `${JSON.stringify(
      {
        name: "support-ui-fixture",
        version: "0.1.0",
        type: "module",
        scripts: {
          start: "node src/server.js",
          test: "node --test",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(target, "src", "server.js"),
    `import http from "node:http";
import { pathToFileURL } from "node:url";

const ticket = {
  id: "TCK-100",
  subject: "Priority customer cannot sign in",
  status: "open",
  priority: "urgent",
  assigneeId: null,
  notes: []
};

function summary() {
  return {
    openTicketCount: ticket.status === "resolved" ? 0 : 1,
    breachedSlaCount: 0,
    urgentTicketCount: ticket.priority === "urgent" && ticket.status !== "resolved" ? 1 : 0,
    unassignedTicketCount: !ticket.assigneeId && ticket.status !== "resolved" ? 1 : 0
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

export function createAppServer() {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>Customer Support Triage Board</title><h1>Customer Support Triage Board</h1>");
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/summary") return sendJson(response, 200, summary());
    if (request.method === "GET" && url.pathname === "/api/tickets/TCK-100") {
      const latestNote = ticket.notes[ticket.notes.length - 1];
      return sendJson(response, 200, { ...ticket, latestNoteBody: latestNote?.body ?? "" });
    }
    if (request.method === "PATCH" && url.pathname === "/api/tickets/TCK-100/assignment") {
      const body = await readJson(request);
      ticket.assigneeId = body.assigneeId;
      return sendJson(response, 200, ticket);
    }
    if (request.method === "PATCH" && url.pathname === "/api/tickets/TCK-100/status") {
      const body = await readJson(request);
      ticket.status = body.status;
      return sendJson(response, 200, ticket);
    }
    if (request.method === "POST" && url.pathname === "/api/tickets/TCK-100/notes") {
      const body = await readJson(request);
      ticket.notes.push(body);
      return sendJson(response, 201, body);
    }
    sendJson(response, 404, { error: "not found" });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 0);
  createAppServer().listen(port, "127.0.0.1", function onListen() {
    const address = this.address();
    console.log(\`Customer Support Triage Board running at http://127.0.0.1:\${address.port}\`);
  });
}
`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(target, "test", "server.test.js"),
    `import test from "node:test";
import assert from "node:assert/strict";
import { createAppServer } from "../src/server.js";

test("support triage server exposes readiness endpoints", async () => {
  const server = createAppServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = \`http://127.0.0.1:\${server.address().port}\`;
  try {
    const html = await (await fetch(url)).text();
    assert.match(html, /Customer Support Triage Board/);
    const summary = await (await fetch(\`\${url}/api/summary\`)).json();
    assert.equal(summary.openTicketCount, 1);
    assert.equal(summary.unassignedTicketCount, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
`,
    "utf8",
  );
}

function writeFakeCodexScript(scriptPath) {
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(
    scriptPath,
    `import fs from "node:fs";
const args = process.argv.slice(2);
const outputPath = argValue("--output-last-message");
const schemaPath = argValue("--output-schema") || "";
const launchPrompt = (() => { try { return fs.readFileSync(0, "utf8"); } catch { return ""; } })();
const prompt = expandPromptArtifact(launchPrompt);
const refs = [...new Set([...prompt.matchAll(/\\b(?:FR|AC)-[A-Z0-9]+(?:-[A-Z0-9]+)*(?:\\.[0-9]+)?\\b/g)].map((match) => match[0]))];
let result;
if (schemaPath.includes("overseer-decision")) {
  result = overseerDecision(prompt);
} else if (schemaPath.includes("review-result")) {
  result = reviewResult(refs);
} else {
  result = workerResult(refs);
}
console.log(JSON.stringify({ type: "thread.started", thread_id: "fake-h2-live-codex" }));
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "fake h2 live codex completed" }] } }));
if (outputPath) fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\\n", "utf8");
console.log(JSON.stringify({ type: "turn.completed" }));

function overseerDecision(prompt) {
  const cli = process.env.FAKE_SWARM_CLI || "node dist/cli.js";
  const sliceId = /SLICE-[a-f0-9]+/i.exec(prompt)?.[0];
  let command;
  let purpose;
  if (!sliceId) {
    command = \`node "\${cli}" slices pull --target support-api --source live-smoke-support-triage-api-requirements.md --new-lane --lane-name "H2 Backend Lane" --lane-purpose "Implement first support API capability pack." --lane-labels support,backend,h2,live-test --batch-size 3\`;
    purpose = "Pull the first backend capability slice.";
  } else if (/"status":\\s*"(ready|blocked|repairing)"/.test(prompt)) {
    command = \`node "\${cli}" run \${sliceId} --actor h2-backend-worker --driver codex\`;
    purpose = "Dispatch backend worker.";
  } else {
    command = \`node "\${cli}" review \${sliceId} --actor h2-backend-reviewer --driver codex\`;
    purpose = "Dispatch independent backend review.";
  }
  return {
    status: "recommend_commands",
    summary: "Fake H2 overseer selected the next real-run lifecycle command.",
    scenario: "live-agent-smoke-h2",
    currentPriority: purpose,
    recommendedCommands: [
      {
        command,
        purpose,
        expectedStateChange: "Harness state advances by one lifecycle step.",
        requiresHuman: false
      }
    ],
    lanePlan: [
      {
        laneName: "H2 Backend Lane",
        purpose: "Bounded fake-codex lifecycle proof for H2 live runner.",
        nextAction: purpose
      }
    ],
    blockers: [],
    stopCondition: "Stop when bounded test reaches verification.",
    nextAction: "execute the recommended command"
  };
}

function workerResult(refs) {
  const selectedRefs = refs.length ? refs : ["AC-SUP-API-001.1"];
  return {
    status: "passed",
    summary: "Fake worker completed H2 backend slice evidence for live-run wiring.",
    changedFiles: ["src/support-api.js", "test/support-api.test.js"],
    commandsRun: ["node --test"],
    testsRun: ["node --test"],
    frAcCoverage: selectedRefs.map((ref) => ({ ref, status: "covered", evidence: "Fake worker evidence for bounded H2 live-run wiring." })),
    risks: [],
    nextRecommendation: "Run independent review."
  };
}

function reviewResult(refs) {
  const selectedRefs = refs.length ? refs : ["AC-SUP-API-001.1"];
  const repairMarker = process.env.FAKE_H2_REPAIR_ONCE_MARKER || "";
  const repairRequired = Boolean(repairMarker) && !fs.existsSync(repairMarker);
  if (repairRequired) fs.writeFileSync(repairMarker, "repair requested once\\n", "utf8");
  const dimensionStatus = repairRequired ? "failed" : "passed";
  const dimensionRisk = repairRequired ? "high" : "none";
  const dimensions = ["runtime_path", "stub_or_hardcode", "test_meaningfulness", "error_handling", "integration_fit", "maintainability", "real_world_readiness"].map((dimension) => ({
    dimension,
    status: dimensionStatus,
    risk: dimensionRisk,
    evidence: ["fake-h2-live-review"],
    finding: repairRequired ? dimension + " needs repair before acceptance" : dimension + " checked for bounded H2 live-run wiring"
  }));
  return {
    status: repairRequired ? "repair_required" : "accepted",
    summary: repairRequired ? "Fake independent review requested one repair before acceptance." : "Fake independent review accepted H2 backend slice evidence.",
    frAcFindings: selectedRefs.map((ref) => ({
      ref,
      status: repairRequired ? "failed" : "passed",
      evidence: ["fake-h2-live-review"],
      finding: repairRequired ? "Requirement needs repair before acceptance." : "Requirement evidence passed review."
    })),
    testAssessment: repairRequired ? "Runtime path needs one repair pass." : "Bounded fake-codex test evidence is coherent for runner wiring.",
    sourceMutationDetected: false,
    stubOrHardcodeRisk: repairRequired ? "high" : "none",
    qualityGate: {
      status: repairRequired ? "failed" : "passed",
      summary: repairRequired ? "Structured quality gate requires repair." : "Structured quality gate completed.",
      dimensions,
      blockingConcerns: repairRequired ? ["runtime path repair required"] : [],
      residualRisks: []
    },
    requiredFixes: repairRequired ? ["Repair runtime path evidence and rerun review."] : [],
    escalations: repairRequired ? [{ level: "blocker", message: "Fake reviewer requested runtime path repair." }] : [],
    recommendation: repairRequired ? "Repair implementation before acceptance." : "Proceed to deterministic verification."
  };
}

function argValue(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function expandPromptArtifact(value) {
  const promptPath = /^([A-Za-z]:\\\\.*overseer-prompt-.*\\.md)$/m.exec(value)?.[1];
  if (promptPath && fs.existsSync(promptPath)) {
    return fs.readFileSync(promptPath, "utf8");
  }
  return value;
}
`,
    "utf8",
  );
  return scriptPath;
}
